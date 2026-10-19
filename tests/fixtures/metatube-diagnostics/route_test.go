package route

import (
	"encoding/json"
	"net/http/httptest"
	"testing"

	"github.com/gin-gonic/gin"
	"github.com/metatube-community/metatube-sdk-go/engine"
	mterr "github.com/metatube-community/metatube-sdk-go/errors"
)

func TestJAVMDiagnosticsRequestIsolation(t *testing.T) {
	gin.SetMode(gin.TestMode)
	firstOutput, secondOutput := httptest.NewRecorder(), httptest.NewRecorder()
	first, _ := gin.CreateTestContext(firstOutput)
	second, _ := gin.CreateTestContext(secondOutput)
	first.Request = httptest.NewRequest("GET", "/v1/movies/search?diagnostics=1", nil)
	second.Request = httptest.NewRequest("GET", "/v1/movies/search?diagnostics=1", nil)
	observeFirst, observeSecond := collectMovieDiagnostics(first, true), collectMovieDiagnostics(second, true)
	observeFirst(engine.MovieDiagnostic{Provider: "First", Category: "incomplete"})
	observeSecond(engine.MovieDiagnostic{Provider: "Second", Category: "denied"})
	abortWithError(first, mterr.FromCode(404))
	var body struct {
		Diagnostics movieDiagnosticRecords `json:"diagnostics"`
	}
	if json.Unmarshal(firstOutput.Body.Bytes(), &body) != nil || firstOutput.Code != 404 {
		t.Fatal("404 diagnostics missing")
	}
	if len(body.Diagnostics.Sources) != 1 || body.Diagnostics.Sources[0].Provider != "First" {
		t.Fatal("cross-request diagnostics leaked")
	}
	for i := 0; i < 80; i++ {
		observeSecond(engine.MovieDiagnostic{Provider: "Second", Category: "empty"})
	}
	records := movieDiagnostics(second).(*movieDiagnosticRecords)
	if len(records.Sources) != 64 || records.Omitted != 17 {
		t.Fatal("collector is not bounded")
	}
}
