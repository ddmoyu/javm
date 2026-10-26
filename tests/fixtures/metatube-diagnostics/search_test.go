package engine

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gocolly/colly/v2"
	mt "github.com/metatube-community/metatube-sdk-go/provider"
	"github.com/metatube-community/metatube-sdk-go/provider/fanza"
	"github.com/metatube-community/metatube-sdk-go/provider/javbus"
)

// Every request is handled by an in-memory transport. No real source, socket,
// metadata database or artwork is accessed by these fixtures.
type issue11Transport func(*http.Request) (*http.Response, error)

func (f issue11Transport) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func issue11Response(r *http.Request, status int, contentType, body string) *http.Response {
	return &http.Response{
		Request: r, StatusCode: status, Header: http.Header{"Content-Type": {contentType}},
		Body: io.NopCloser(strings.NewReader(body)),
	}
}

const issue11Result = `<html><body><a class="movie-box" href="https://example.invalid/SAFE-001"><div><img src="https://example.invalid/thumbs/safe001.jpg"></div><div><span>Safe sample
<date>SAFE-001</date><date>2026-01-01</date></span></div></a></body></html>`

func TestJAVMDiagnosticsIssue11JavBus(t *testing.T) {
	for _, name := range []string{"timeout", "denied", "partial", "empty", "invalid_with_failure"} {
		t.Run(name, func(t *testing.T) {
			bus := javbus.New()
			var requests atomic.Int32
			bus.ClonedCollector().WithTransport(issue11Transport(func(r *http.Request) (*http.Response, error) {
				requests.Add(1)
				if name == "timeout" || ((name == "partial" || name == "invalid_with_failure") && strings.Contains(r.URL.Path, "/uncensored/")) {
					return nil, context.DeadlineExceeded
				}
				if name == "denied" {
					return issue11Response(r, 403, "text/html", "Safe forbidden fixture"), nil
				}
				body := "<html><body>Safe empty fixture</body></html>"
				if name == "partial" {
					body = issue11Result
				} else if name == "invalid_with_failure" {
					body = strings.ReplaceAll(issue11Result, "<date>SAFE-001</date>", "<date></date>")
				}
				return issue11Response(r, 200, "text/html; charset=utf-8", body), nil
			}))
			results, err := bus.SearchMovie("SAFE-001")
			item := NewMovieDiagnostic("JavBus", results, err, time.Millisecond)
			if requests.Load() != 2 {
				t.Fatal("both search branches must finish")
			}
			switch name {
			case "timeout", "invalid_with_failure":
				if !errors.Is(err, context.DeadlineExceeded) || item.Category != "timeout" || item.Reason != "request_failed" {
					t.Fatalf("timeout became no results: %#v", item)
				}
			case "denied":
				if err == nil || item.Category != "denied" || item.Stage != "response" || item.HTTPStatus != 403 {
					t.Fatalf("denial lost HTTP status: %#v", item)
				}
			case "partial":
				if err != nil || len(results) != 1 || item.Category != "found" {
					t.Fatal("one failed branch discarded the valid result")
				}
			case "empty":
				if err != nil || item.Category != "empty" || item.Results == nil || *item.Results != 0 {
					t.Fatal("successful empty pages must stay empty")
				}
			}
		})
	}
}

func TestJAVMDiagnosticsIssue11FANZA(t *testing.T) {
	const emptyData = `<html><script>self.__next_f = [[0], [1, '0:[{"backendResponse":{"contents":{"count":0,"data":[]}}}]']];</script></html>`
	for _, row := range []struct {
		name, body, contentType, category, reason, stage string
		status                                           int
	}{
		{"missing", "<html>Safe empty page</html>", "text/html", "parse", "missing_page_data", "parse", 200},
		{"invalid", `<html><script>self.__next_f = [];</script></html>`, "text/html", "parse", "invalid_page_data", "parse", 200},
		{"script", `<html><script>self.__next_f = ;</script></html>`, "text/html", "parse", "page_script_failed", "parse", 200},
		{"json", `{"safe":"fixture"}`, "application/json", "parse", "unexpected_content_type", "response", 200},
		{"challenge_header", "<html>Safe challenge fixture</html>", "text/html", "denied", "challenge_page", "response", 200},
		{"challenge_body", `<html><form id="challenge-form"></form><script src="/cdn-cgi/challenge-platform/safe.js"></script></html>`, "text/html", "denied", "challenge_page", "response", 200},
		{"forbidden", "<html>Safe forbidden fixture</html>", "text/html", "denied", "http_status", "response", 403},
		{"rate_limit", "<html>Safe rate limit fixture</html>", "text/html", "rate_limited", "http_status", "response", 429},
		{"upstream", "<html>Safe server error fixture</html>", "text/html", "upstream", "http_status", "response", 503},
		{"not_found", "<html>Safe missing page fixture</html>", "text/html", "empty", "http_status", "response", 404},
		{"region", "<html>Safe region fixture</html>", "text/html", "denied", "region_restricted", "response", 200},
		{"empty", emptyData, "text/html", "empty", "", "", 200},
	} {
		t.Run(row.name, func(t *testing.T) {
			fz := fanza.New()
			fz.ClonedCollector().WithTransport(issue11Transport(func(r *http.Request) (*http.Response, error) {
				if row.name == "region" && r.URL.Path != "/not-available-in-your-region" {
					response := issue11Response(r, 302, "text/html", "")
					response.Header.Set("Location", "https://example.invalid/not-available-in-your-region")
					return response, nil
				}
				response := issue11Response(r, row.status, row.contentType, row.body)
				if row.name == "challenge_header" {
					response.Header.Set("Cf-Mitigated", "challenge")
				}
				return response, nil
			}))
			results, err := fz.SearchMovie("SAFE001")
			item := NewMovieDiagnostic("FANZA", results, err, time.Millisecond)
			if item.Category != row.category || item.Reason != row.reason || item.Stage != row.stage {
				t.Fatalf("wrong response diagnosis: %#v; fixture parser error: %v", item, errors.Unwrap(err))
			}
			if row.reason != "" && (err == nil || item.HTTPStatus != row.status) {
				t.Fatal("failure status missing")
			}
			if row.name == "empty" && (err != nil || len(results) != 0) {
				t.Fatal("valid empty response must stay empty")
			}
		})
	}
}

func TestJAVMDiagnosticsIssue11WrappedTransport(t *testing.T) {
	for _, row := range []struct {
		category string
		cause    error
	}{
		{"dns", &net.DNSError{Err: "safe fixture"}},
		{"timeout", context.DeadlineExceeded},
		{"tls", errors.New("x509: safe fixture certificate failure")},
		{"network", &url.Error{Op: "GET", URL: "https://example.invalid", Err: errors.New("safe connection failure")}},
	} {
		t.Run(row.category, func(t *testing.T) {
			fz := fanza.New()
			fz.ClonedCollector().WithTransport(issue11Transport(func(*http.Request) (*http.Response, error) {
				return nil, row.cause
			}))
			results, err := fz.SearchMovie("SAFE001")
			item := NewMovieDiagnostic("FANZA", results, err, time.Millisecond)
			if item.Category != row.category || item.Reason != "request_failed" || item.Stage != "request" || !errors.Is(err, row.cause) {
				t.Fatalf("transport identity lost: %#v", item)
			}
		})
	}
}

func TestJAVMDiagnosticsIssue11JoinedFailures(t *testing.T) {
	denied := mt.MovieRequestError(&colly.Response{StatusCode: 403}, errors.New("Safe denied"))
	timeout := mt.MovieRequestError(nil, context.DeadlineExceeded)
	item := NewMovieDiagnostic("JavBus", nil, errors.Join(denied, timeout), time.Millisecond)
	if item.Category != "timeout" || item.Stage != "request" || item.Reason != "request_failed" || item.HTTPStatus != 0 {
		t.Fatalf("joined timeout inherited another request's HTTP status: %#v", item)
	}
}

func TestJAVMDiagnosticsIssue11ContentFreeErrors(t *testing.T) {
	failure := &mt.MovieSourceError{
		Stage: "parse", Reason: "invalid_page_data", HTTPStatus: 200,
		Cause: errors.New("Safe private page text https://example.invalid/?token=fake-secret"),
	}
	data, err := json.Marshal(NewMovieDiagnostic("FANZA", nil, failure, time.Millisecond))
	if err != nil || strings.Contains(string(data), "private") || strings.Contains(string(data), "fake-secret") || strings.Contains(failure.Error(), "example.invalid") {
		t.Fatal("raw error escaped the diagnostic boundary")
	}
}
