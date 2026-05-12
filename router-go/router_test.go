package router

import (
	"context"
	"sync"
	"testing"
	"time"
)

func TestRouterUsesDefaultTargetLanguage(t *testing.T) {
	sink := &memorySink{}
	r := New(Options{DefaultTargetLanguage: "en", MaxQueue: 4})
	r.Register("en", sink)

	err := r.Route(context.Background(), Frame{
		SessionID:        "test",
		CapturedAtUnixMs: time.Now().UnixMilli(),
		Payload:          []byte{1, 2, 3},
	})
	if err != nil {
		t.Fatalf("Route returned error: %v", err)
	}
	if len(sink.frames) != 1 {
		t.Fatalf("expected 1 frame, got %d", len(sink.frames))
	}
	if sink.frames[0].TargetLanguage != "en" {
		t.Fatalf("expected default target en, got %q", sink.frames[0].TargetLanguage)
	}
}

func TestWireFrameRoundTrip(t *testing.T) {
	line := []byte(`{"session_id":"s1","source_language":"auto","target_language":"ko","captured_at_unix_ms":123,"payload_b64":"AQID"}`)
	frame, err := ParseWireFrame(line)
	if err != nil {
		t.Fatalf("ParseWireFrame returned error: %v", err)
	}
	if frame.SessionID != "s1" || frame.SourceLanguage != "auto" || frame.TargetLanguage != "ko" || frame.CapturedAtUnixMs != 123 {
		t.Fatalf("unexpected frame metadata: %#v", frame)
	}
	if string(frame.Payload) != string([]byte{1, 2, 3}) {
		t.Fatalf("unexpected payload: %#v", frame.Payload)
	}
	formatted, err := FormatWireFrame(frame)
	if err != nil {
		t.Fatalf("FormatWireFrame returned error: %v", err)
	}
	roundTrip, err := ParseWireFrame(formatted)
	if err != nil {
		t.Fatalf("ParseWireFrame formatted returned error: %v", err)
	}
	if roundTrip.SessionID != frame.SessionID || roundTrip.TargetLanguage != frame.TargetLanguage || string(roundTrip.Payload) != string(frame.Payload) {
		t.Fatalf("round trip mismatch: got %#v want %#v", roundTrip, frame)
	}
}

func TestRouterLatencyBudget(t *testing.T) {
	var slowest time.Duration
	r := New(Options{
		DefaultTargetLanguage: "ko",
		MaxQueue:              64,
		OnMetric: func(metric Metric) {
			if metric.RouteLatency > slowest {
				slowest = metric.RouteLatency
			}
		},
	})
	r.Register("ko", &memorySink{})

	for i := 0; i < 10_000; i++ {
		err := r.Route(context.Background(), Frame{
			SessionID:        "bench",
			CapturedAtUnixMs: time.Now().UnixMilli(),
			Payload:          []byte{byte(i)},
		})
		if err != nil {
			t.Fatalf("Route returned error at frame %d: %v", i, err)
		}
	}

	if slowest > 700*time.Millisecond {
		t.Fatalf("router overhead exceeded 700 ms: %s", slowest)
	}
	if slowest > time.Millisecond {
		t.Fatalf("router overhead should stay comfortably below network latency, got %s", slowest)
	}
}

type memorySink struct {
	mu     sync.Mutex
	frames []Frame
}

func (m *memorySink) WriteFrame(_ context.Context, frame Frame) error {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.frames = append(m.frames, frame)
	return nil
}
