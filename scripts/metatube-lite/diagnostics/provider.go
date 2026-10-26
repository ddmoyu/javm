package provider

import (
	"bytes"
	"mime"
	"strings"

	"github.com/gocolly/colly/v2"
	mterr "github.com/metatube-community/metatube-sdk-go/errors"
)

// Only fixed codes and HTTP status cross the diagnostic boundary. The wrapped
// cause retains transport error identity without exposing response content.
type MovieSourceError struct {
	Stage      string
	Reason     string
	HTTPStatus int
	Cause      error
}

func (e *MovieSourceError) Error() string { return "metadata source failure: " + e.Reason }
func (e *MovieSourceError) Unwrap() error { return e.Cause }

func MovieResponseError(r *colly.Response) *MovieSourceError {
	if r == nil {
		return nil
	}
	var contentType, mitigated string
	if r.Headers != nil {
		contentType = r.Headers.Get("Content-Type")
		mitigated = r.Headers.Get("Cf-Mitigated")
	}
	// A form marker alone may belong to ordinary page content. Require the
	// challenge endpoint as well, and inspect only a bounded prefix.
	body := r.Body[:min(len(r.Body), 64*1024)]
	challenge := strings.EqualFold(strings.TrimSpace(mitigated), "challenge") ||
		(bytes.Contains(body, []byte("/cdn-cgi/challenge-platform/")) &&
			(bytes.Contains(body, []byte(`id="challenge-form"`)) || bytes.Contains(body, []byte(`id='challenge-form'`))))
	if challenge {
		return &MovieSourceError{Stage: "response", Reason: "challenge_page", HTTPStatus: r.StatusCode}
	}
	if r.StatusCode >= 400 {
		return &MovieSourceError{Stage: "response", Reason: "http_status", HTTPStatus: r.StatusCode, Cause: mterr.FromCode(r.StatusCode)}
	}
	if contentType != "" {
		kind, _, err := mime.ParseMediaType(contentType)
		if err != nil || (kind != "text/html" && kind != "application/xhtml+xml") {
			return &MovieSourceError{Stage: "response", Reason: "unexpected_content_type", HTTPStatus: r.StatusCode}
		}
	}
	return nil
}

func MovieRequestError(r *colly.Response, cause error) error {
	if response := MovieResponseError(r); response != nil {
		// Keep the typed HTTP cause when one exists; otherwise preserve the
		// transport error, which can identify timeouts, DNS and TLS failures.
		if response.Cause == nil {
			response.Cause = cause
		}
		return response
	}
	return &MovieSourceError{Stage: "request", Reason: "request_failed", Cause: cause}
}
