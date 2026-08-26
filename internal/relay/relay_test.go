package relay_test

import (
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"github.com/2233admin/agx/internal/relay"
)

func TestHandlerAuthAndModelsProxy(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Header.Get("Authorization") != "" {
			t.Fatalf("client authorization leaked upstream")
		}
		fmt.Fprint(writer, `{"object":"list","data":[]}`)
	}))
	defer upstream.Close()

	target, _ := url.Parse(upstream.URL)
	handler, err := relay.NewHandler(relay.Config{UpstreamURL: target.String(), ClientToken: "relay-token"})
	if err != nil {
		t.Fatal(err)
	}

	unauthorized := httptest.NewRecorder()
	handler.ServeHTTP(unauthorized, httptest.NewRequest(http.MethodGet, "/v1/models", nil))
	if unauthorized.Code != http.StatusUnauthorized {
		t.Fatalf("unauthorized status = %d", unauthorized.Code)
	}

	authorized := httptest.NewRecorder()
	request := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	request.Header.Set("Authorization", "Bearer relay-token")
	handler.ServeHTTP(authorized, request)
	if authorized.Code != http.StatusOK {
		t.Fatalf("authorized status = %d", authorized.Code)
	}
}

func TestHandlerProxiesStreamingChat(t *testing.T) {
	upstream := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		if request.Method != http.MethodPost {
			t.Fatalf("upstream method = %s, want POST", request.Method)
		}
		writer.Header().Set("Content-Type", "text/event-stream")
		flusher, ok := writer.(http.Flusher)
		if !ok {
			t.Fatal("upstream writer does not support flushing")
		}
		fmt.Fprint(writer, "data: first\n\n")
		flusher.Flush()
		time.Sleep(10 * time.Millisecond)
		fmt.Fprint(writer, "data: [DONE]\n\n")
	}))
	defer upstream.Close()

	target, _ := url.Parse(upstream.URL)
	handler, err := relay.NewHandler(relay.Config{UpstreamURL: target.String(), ClientToken: "relay-token"})
	if err != nil {
		t.Fatal(err)
	}

	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", strings.NewReader(`{"stream":true}`))
	request.Header.Set("Authorization", "Bearer relay-token")
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("streaming chat status = %d, want 200", response.Code)
	}
	body, err := io.ReadAll(response.Result().Body)
	if err != nil {
		t.Fatal(err)
	}
	if string(body) != "data: first\n\ndata: [DONE]\n\n" {
		t.Fatalf("streaming chat body = %q", string(body))
	}
}

func TestHandlerHealthIsPublicAndUnknownPathIsNot(t *testing.T) {
	target, _ := url.Parse("http://127.0.0.1:1")
	handler, err := relay.NewHandler(relay.Config{UpstreamURL: target.String(), ClientToken: "relay-token"})
	if err != nil {
		t.Fatal(err)
	}

	health := httptest.NewRecorder()
	handler.ServeHTTP(health, httptest.NewRequest(http.MethodGet, "/health", nil))
	if health.Code != http.StatusOK {
		t.Fatalf("health status = %d", health.Code)
	}

	unknown := httptest.NewRecorder()
	handler.ServeHTTP(unknown, httptest.NewRequest(http.MethodGet, "/admin", nil))
	if unknown.Code != http.StatusNotFound {
		t.Fatalf("unknown path status = %d", unknown.Code)
	}
}

func TestNewHandlerRejectsEmbeddedUpstreamCredentials(t *testing.T) {
	if _, err := relay.NewHandler(relay.Config{UpstreamURL: "http://user:password@example.test"}); err == nil {
		t.Fatal("expected embedded credentials to be rejected")
	}
}
