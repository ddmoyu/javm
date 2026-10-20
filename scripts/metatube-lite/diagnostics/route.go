package route

import (
	"github.com/gin-gonic/gin"
	"github.com/metatube-community/metatube-sdk-go/engine"
)

type movieDiagnosticRecords struct {
	Schema  int                      `json:"schema"`
	Sources []engine.MovieDiagnostic `json:"sources"`
	Omitted int                      `json:"omitted,omitempty"`
}

// This collector belongs to one HTTP request. It is never process-global.
func collectMovieDiagnostics(c *gin.Context, enabled bool) func(engine.MovieDiagnostic) {
	if !enabled || c.Query("diagnostics") != "1" {
		return nil
	}
	records := &movieDiagnosticRecords{Schema: 1, Sources: make([]engine.MovieDiagnostic, 0, 32)}
	c.Set("javm.movieDiagnostics", records)
	return func(record engine.MovieDiagnostic) {
		if len(records.Sources) < 64 {
			records.Sources = append(records.Sources, record)
		} else {
			records.Omitted++
		}
	}
}
func movieDiagnostics(c *gin.Context) any {
	if value, ok := c.Get("javm.movieDiagnostics"); ok {
		return value.(*movieDiagnosticRecords)
	}
	return nil
}
