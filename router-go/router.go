package router

import (
	"context"
	"errors"
	"sync"
	"time"
)

var (
	ErrNoTargetLanguage = errors.New("target language is required")
	ErrRouteNotFound    = errors.New("route not found for target language")
	ErrQueueFull        = errors.New("route queue is full")
)

type Frame struct {
	SessionID        string
	SourceLanguage   string
	TargetLanguage   string
	CapturedAtUnixMs int64
	Payload          []byte
}

type Sink interface {
	WriteFrame(context.Context, Frame) error
}

type Metric struct {
	SessionID      string
	TargetLanguage string
	RouteLatency   time.Duration
	CaptureLatency time.Duration
	QueueDepth     int
	Dropped        bool
}

type Options struct {
	DefaultTargetLanguage string
	MaxQueue              int
	OnMetric              func(Metric)
}

type Router struct {
	mu       sync.RWMutex
	routes   map[string]*route
	defaults Options
}

type route struct {
	sink Sink
	sem  chan struct{}
}

func New(options Options) *Router {
	return &Router{
		routes:   make(map[string]*route),
		defaults: options,
	}
}

func (r *Router) Register(targetLanguage string, sink Sink) {
	r.mu.Lock()
	defer r.mu.Unlock()
	maxQueue := r.defaults.MaxQueue
	if maxQueue <= 0 {
		maxQueue = 1
	}
	r.routes[targetLanguage] = &route{
		sink: sink,
		sem:  make(chan struct{}, maxQueue),
	}
}

func (r *Router) Route(ctx context.Context, frame Frame) error {
	startedAt := time.Now()
	targetLanguage := frame.TargetLanguage
	if targetLanguage == "" {
		targetLanguage = r.defaults.DefaultTargetLanguage
	}
	if targetLanguage == "" {
		r.emit(frame, targetLanguage, startedAt, 0, true)
		return ErrNoTargetLanguage
	}

	r.mu.RLock()
	route := r.routes[targetLanguage]
	r.mu.RUnlock()
	if route == nil {
		r.emit(frame, targetLanguage, startedAt, 0, true)
		return ErrRouteNotFound
	}

	select {
	case route.sem <- struct{}{}:
		defer func() { <-route.sem }()
	default:
		r.emit(frame, targetLanguage, startedAt, len(route.sem), true)
		return ErrQueueFull
	}

	routed := frame
	routed.TargetLanguage = targetLanguage
	err := route.sink.WriteFrame(ctx, routed)
	r.emit(routed, targetLanguage, startedAt, len(route.sem), err != nil)
	return err
}

func (r *Router) emit(frame Frame, targetLanguage string, startedAt time.Time, queueDepth int, dropped bool) {
	if r.defaults.OnMetric == nil {
		return
	}
	captureLatency := time.Duration(0)
	if frame.CapturedAtUnixMs > 0 {
		captureLatency = time.Since(time.UnixMilli(frame.CapturedAtUnixMs))
	}
	r.defaults.OnMetric(Metric{
		SessionID:      frame.SessionID,
		TargetLanguage: targetLanguage,
		RouteLatency:   time.Since(startedAt),
		CaptureLatency: captureLatency,
		QueueDepth:     queueDepth,
		Dropped:        dropped,
	})
}
