package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"time"

	router "co-translator/router-go"
)

type metricJSON struct {
	Frames        int     `json:"frames"`
	P50RouteMs    float64 `json:"p50_route_ms"`
	P95RouteMs    float64 `json:"p95_route_ms"`
	MaxRouteMs    float64 `json:"max_route_ms"`
	TargetBudget  float64 `json:"target_budget_ms"`
	WithinBudget  bool    `json:"within_budget"`
	DefaultTarget string  `json:"default_target_language"`
}

func main() {
	frames := 10_000
	budget := 700 * time.Millisecond
	routeLatencies := make([]time.Duration, 0, frames)
	r := router.New(router.Options{
		DefaultTargetLanguage: "ko",
		MaxQueue:              64,
		OnMetric: func(metric router.Metric) {
			routeLatencies = append(routeLatencies, metric.RouteLatency)
		},
	})
	r.Register("ko", discardSink{})

	for i := 0; i < frames; i++ {
		err := r.Route(context.Background(), router.Frame{
			SessionID:        "bench",
			SourceLanguage:   "auto",
			CapturedAtUnixMs: time.Now().UnixMilli(),
			Payload:          []byte{byte(i), byte(i >> 8)},
		})
		if err != nil {
			fmt.Fprintf(os.Stderr, "route failed: %v\n", err)
			os.Exit(1)
		}
	}

	sort.Slice(routeLatencies, func(i, j int) bool {
		return routeLatencies[i] < routeLatencies[j]
	})
	result := metricJSON{
		Frames:        frames,
		P50RouteMs:    millis(percentile(routeLatencies, 0.50)),
		P95RouteMs:    millis(percentile(routeLatencies, 0.95)),
		MaxRouteMs:    millis(routeLatencies[len(routeLatencies)-1]),
		TargetBudget:  millis(budget),
		WithinBudget:  percentile(routeLatencies, 0.95) < time.Millisecond && routeLatencies[len(routeLatencies)-1] < budget,
		DefaultTarget: "ko",
	}
	encoded, err := json.Marshal(result)
	if err != nil {
		fmt.Fprintf(os.Stderr, "encode result: %v\n", err)
		os.Exit(1)
	}
	fmt.Println(string(encoded))
	if !result.WithinBudget {
		os.Exit(3)
	}
}

func percentile(values []time.Duration, p float64) time.Duration {
	if len(values) == 0 {
		return 0
	}
	index := int(float64(len(values)-1) * p)
	return values[index]
}

func millis(value time.Duration) float64 {
	return float64(value.Microseconds()) / 1000
}

type discardSink struct{}

func (discardSink) WriteFrame(context.Context, router.Frame) error {
	return nil
}
