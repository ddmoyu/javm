// JAVM: bounded, content-free diagnostics; provider behavior and cache data stay upstream.
package engine

import (
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"

	mterr "github.com/metatube-community/metatube-sdk-go/errors"
	"github.com/metatube-community/metatube-sdk-go/model"
	mt "github.com/metatube-community/metatube-sdk-go/provider"
)

type MovieDiagnostic struct {
	Provider      string   `json:"provider"`
	Category      string   `json:"category"`
	ElapsedMs     int64    `json:"elapsedMs"`
	Results       *int     `json:"results,omitempty"`
	MissingFields []string `json:"missingFields,omitempty"`
}

type incompleteMovieMetadata struct{ fields []string }

func (e *incompleteMovieMetadata) Error() string { return mt.ErrIncompleteMetadata.Error() }
func (e *incompleteMovieMetadata) Unwrap() error { return mt.ErrIncompleteMetadata }
func missingMovieFields(info *model.MovieInfo) []string {
	if info == nil {
		return []string{"metadata"}
	}
	result := []string{}
	for _, field := range []struct{ name, value string }{
		{"id", info.ID}, {"number", info.Number}, {"title", info.Title},
		{"cover_url", info.CoverURL}, {"provider", info.Provider}, {"homepage", info.Homepage},
	} {
		if field.value == "" {
			result = append(result, field.name)
		}
	}
	return result
}
func movieDiagnosticCategory(err error) string {
	if err == nil {
		return "empty"
	}
	if errors.Is(err, mt.ErrInvalidID) || errors.Is(err, mt.ErrInvalidKeyword) {
		return "skipped"
	}
	if errors.Is(err, mt.ErrIncompleteMetadata) {
		return "incomplete"
	}
	if errors.Is(err, mt.ErrInfoNotFound) {
		return "empty"
	}
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "x509:") || strings.Contains(message, "tls:") || strings.Contains(message, "certificate") {
		return "tls"
	}
	var dns *net.DNSError
	if errors.As(err, &dns) {
		return "dns"
	}
	var network net.Error
	if errors.As(err, &network) && network.Timeout() {
		return "timeout"
	}
	var status *mterr.HTTPError
	code := mterr.StatusCode(err)
	if errors.As(err, &status) {
		code = status.Code
	}
	switch code {
	case http.StatusUnauthorized, http.StatusForbidden:
		return "denied"
	case http.StatusTooManyRequests:
		return "rate_limited"
	case http.StatusNotFound:
		return "empty"
	case http.StatusRequestTimeout, http.StatusGatewayTimeout:
		return "timeout"
	}
	if code >= 500 {
		return "upstream"
	}
	for _, pattern := range []string{"__next_f", "does not contain key", "unmarshal", "invalid character", "unexpected end", "parse", "selector"} {
		if strings.Contains(message, pattern) {
			return "parse"
		}
	}
	var request *url.Error
	if errors.As(err, &request) || errors.As(err, &network) {
		return "network"
	}
	return "unknown"
}

// No query, URL, title, description, raw exception, or credential is returned here.
func NewMovieDiagnostic(provider string, result any, err error, elapsed time.Duration) MovieDiagnostic {
	diagnostic := MovieDiagnostic{Provider: provider, Category: movieDiagnosticCategory(err), ElapsedMs: elapsed.Milliseconds()}
	var incomplete *incompleteMovieMetadata
	if errors.As(err, &incomplete) {
		diagnostic.MissingFields = incomplete.fields
	}
	if err == nil {
		count := 0
		invalid := false
		switch values := result.(type) {
		case []*model.MovieSearchResult:
			for _, value := range values {
				if value != nil && value.IsValid() {
					count++
				} else {
					invalid = true
				}
			}
		case *model.MovieInfo:
			if values != nil && values.IsValid() {
				count++
			} else {
				invalid = true
				diagnostic.MissingFields = missingMovieFields(values)
			}
		}
		diagnostic.Results = &count
		if count > 0 {
			diagnostic.Category = "found"
		} else if invalid {
			diagnostic.Category = "incomplete"
		}
	}
	return diagnostic
}
func emitMovieDiagnostic(observers []func(MovieDiagnostic), diagnostic MovieDiagnostic) {
	for _, observe := range observers {
		if observe != nil {
			observe(diagnostic)
		}
	}
}
