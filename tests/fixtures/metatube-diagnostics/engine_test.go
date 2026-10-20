package engine

import (
	"encoding/json"
	"errors"
	"net"
	"strings"
	"testing"
	"time"

	"github.com/metatube-community/metatube-sdk-go/model"
	mt "github.com/metatube-community/metatube-sdk-go/provider"
)

func TestJAVMDiagnosticsCategories(t *testing.T) {
	for _, row := range []struct {
		err      error
		expected string
	}{
		{mt.ErrInvalidID, "skipped"}, {mt.ErrInvalidKeyword, "skipped"}, {mt.ErrInfoNotFound, "empty"},
		{errors.New("Forbidden"), "denied"}, {errors.New("x509: certificate does not match safe.invalid"), "tls"},
		{&net.DNSError{Err: "safe fixture", IsTimeout: true}, "dns"},
		{errors.New("var self does not contain key __next_f"), "parse"},
		{errors.New("unclassified fixture"), "unknown"},
	} {
		if got := movieDiagnosticCategory(row.err); got != row.expected {
			t.Fatalf("category=%s, expected=%s", got, row.expected)
		}
	}
}
func TestJAVMDiagnosticsFieldsAndCounts(t *testing.T) {
	info := &model.MovieInfo{ID: "safe-id", Number: "SAFE-001", Provider: "Fixture", Homepage: "https://example.invalid/private?token=fake-secret"}
	err := &incompleteMovieMetadata{fields: missingMovieFields(info)}
	if !errors.Is(err, mt.ErrIncompleteMetadata) {
		t.Fatal("wrapped error lost its identity")
	}
	item := NewMovieDiagnostic("Fixture", info, err, 25*time.Millisecond)
	if strings.Join(item.MissingFields, ",") != "title,cover_url" || item.Category != "incomplete" {
		t.Fatalf("wrong missing fields: %#v", item)
	}
	data, _ := json.Marshal(item)
	if strings.Contains(string(data), "fake-secret") || strings.Contains(string(data), "example.invalid") || strings.Contains(string(data), "safe-id") {
		t.Fatal("diagnostic contains metadata values")
	}
	empty := NewMovieDiagnostic("Fixture", []*model.MovieSearchResult{}, nil, time.Millisecond)
	if empty.Results == nil || *empty.Results != 0 || empty.Category != "empty" {
		t.Fatal("nil error must not imply results")
	}
	found := NewMovieDiagnostic("Fixture", []*model.MovieSearchResult{{ID: "safe", Number: "SAFE-001", Title: "Safe fixture", Provider: "Fixture", Homepage: "https://example.invalid"}}, nil, time.Millisecond)
	if found.Results == nil || *found.Results != 1 || found.Category != "found" {
		t.Fatal("result count missing")
	}
}
