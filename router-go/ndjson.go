package router

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
)

type WireFrame struct {
	SessionID        string `json:"session_id"`
	SourceLanguage   string `json:"source_language,omitempty"`
	TargetLanguage   string `json:"target_language,omitempty"`
	CapturedAtUnixMs int64  `json:"captured_at_unix_ms,omitempty"`
	PayloadB64       string `json:"payload_b64"`
}

func ParseWireFrame(line []byte) (Frame, error) {
	var wire WireFrame
	if err := json.Unmarshal(line, &wire); err != nil {
		return Frame{}, fmt.Errorf("decode wire frame: %w", err)
	}
	payload, err := base64.StdEncoding.DecodeString(wire.PayloadB64)
	if err != nil {
		return Frame{}, fmt.Errorf("decode payload_b64: %w", err)
	}
	return Frame{
		SessionID:        wire.SessionID,
		SourceLanguage:   wire.SourceLanguage,
		TargetLanguage:   wire.TargetLanguage,
		CapturedAtUnixMs: wire.CapturedAtUnixMs,
		Payload:          payload,
	}, nil
}

func FormatWireFrame(frame Frame) ([]byte, error) {
	return json.Marshal(WireFrame{
		SessionID:        frame.SessionID,
		SourceLanguage:   frame.SourceLanguage,
		TargetLanguage:   frame.TargetLanguage,
		CapturedAtUnixMs: frame.CapturedAtUnixMs,
		PayloadB64:       base64.StdEncoding.EncodeToString(frame.Payload),
	})
}
