package main

import (
	"bufio"
	"context"
	"encoding/base64"
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/gorilla/websocket"
)

type clientEvent struct {
	Type    string         `json:"type"`
	Session *sessionUpdate `json:"session,omitempty"`
	Audio   string         `json:"audio,omitempty"`
}

type sessionUpdate struct {
	Audio audioConfig `json:"audio"`
}

type audioConfig struct {
	Output outputAudio `json:"output"`
}

type outputAudio struct {
	Language string `json:"language"`
}

type serverEvent struct {
	Type       string          `json:"type"`
	Delta      string          `json:"delta,omitempty"`
	Error      *realtimeError  `json:"error,omitempty"`
	Transcript string          `json:"transcript,omitempty"`
	Raw        json.RawMessage `json:"-"`
}

type realtimeError struct {
	Message string `json:"message"`
	Code    string `json:"code"`
}

const syntheticLeadingSilenceMs int64 = 400

func main() {
	targetLanguage := flag.String("target", getenv("SMOKE_TARGET_LANGUAGE", "ko"), "target output language code")
	text := flag.String("text", getenv("SMOKE_TEXT", "hello my name is Tony and I am testing live translation"), "text rendered by macOS say")
	rate := flag.String("rate", getenv("SMOKE_RATE", "220"), "macOS say speech rate")
	voice := flag.String("voice", getenv("SMOKE_VOICE", ""), "optional macOS say voice")
	gateMetric := flag.String("metric", getenv("LATENCY_GATE_METRIC", "text"), "latency gate: text, audio, or first")
	targetMs := flag.Int("target-ms", intEnv("LATENCY_TARGET_MS", 700), "latency target in milliseconds")
	flag.Parse()

	loadEnvFiles("../.env.local", "../.env")
	apiKey := os.Getenv("OPENAI_API_KEY")
	if apiKey == "" {
		fmt.Fprintln(os.Stderr, "OPENAI_API_KEY is missing")
		os.Exit(2)
	}

	pcmPath, cleanup, err := synthesizePCM(*text, *rate, *voice)
	if err != nil {
		fmt.Fprintf(os.Stderr, "synthesize pcm: %v\n", err)
		os.Exit(2)
	}
	defer cleanup()
	speechOffsetMs, err := detectSpeechOnsetMs(pcmPath)
	if err != nil {
		fmt.Fprintf(os.Stderr, "detect speech onset: %v\n", err)
		os.Exit(2)
	}

	metric, err := runSmoke(context.Background(), apiKey, *targetLanguage, pcmPath, *gateMetric, speechOffsetMs)
	if err != nil {
		fmt.Fprintf(os.Stderr, "smoke failed: %v\n", err)
		os.Exit(3)
	}
	encoded, _ := json.Marshal(metric)
	fmt.Println(string(encoded))
	if metric.SpeechToTargetMs > int64(*targetMs) {
		fmt.Fprintf(os.Stderr, "FAIL: Go WebSocket speech-to-target %s %d ms exceeds %d ms\n", metric.GateMetric, metric.SpeechToTargetMs, *targetMs)
		os.Exit(3)
	}
	fmt.Printf("PASS: Go WebSocket speech-to-target %s %d ms <= %d ms\n", metric.GateMetric, metric.SpeechToTargetMs, *targetMs)
}

type smokeMetric struct {
	Transport        string `json:"transport"`
	TargetLanguage   string `json:"target_language"`
	GateMetric       string `json:"gate_metric"`
	ConnectMs        int64  `json:"connect_ms"`
	SpeechOffsetMs   int64  `json:"speech_offset_ms"`
	SpeechToTargetMs int64  `json:"speech_to_target_ms"`
	FirstDeltaBytes  int    `json:"first_delta_bytes"`
}

func runSmoke(ctx context.Context, apiKey string, targetLanguage string, pcmPath string, gateMetric string, speechOffsetMs int64) (smokeMetric, error) {
	if gateMetric != "text" && gateMetric != "audio" && gateMetric != "first" {
		return smokeMetric{}, fmt.Errorf("unsupported latency gate %q", gateMetric)
	}
	dialStartedAt := time.Now()
	model := getenv("OPENAI_REALTIME_MODEL", "gpt-realtime-translate")
	header := http.Header{}
	header.Set("Authorization", "Bearer "+apiKey)
	header.Set("OpenAI-Safety-Identifier", "co-translator-go-router-smoke")
	conn, _, err := websocket.DefaultDialer.DialContext(ctx, "wss://api.openai.com/v1/realtime/translations?model="+model, header)
	if err != nil {
		return smokeMetric{}, err
	}
	defer conn.Close()
	connectMs := time.Since(dialStartedAt).Milliseconds()

	if err := conn.WriteJSON(clientEvent{
		Type: "session.update",
		Session: &sessionUpdate{
			Audio: audioConfig{
				Output: outputAudio{Language: targetLanguage},
			},
		},
	}); err != nil {
		return smokeMetric{}, err
	}
	if err := waitForSessionUpdated(conn); err != nil {
		return smokeMetric{}, err
	}

	result := make(chan smokeMetric, 1)
	errs := make(chan error, 1)
	speechStartedAt := time.Now().Add(time.Duration(speechOffsetMs) * time.Millisecond)
	go func() {
		for {
			_, data, err := conn.ReadMessage()
			if err != nil {
				errs <- err
				return
			}
			var event serverEvent
			if err := json.Unmarshal(data, &event); err != nil {
				continue
			}
			if event.Type == "error" {
				if event.Error != nil {
					errs <- fmt.Errorf("%s", event.Error.Message)
				} else {
					errs <- fmt.Errorf("realtime api error")
				}
				return
			}
			if event.Type == "session.output_transcript.delta" && event.Delta != "" && (gateMetric == "text" || gateMetric == "first") {
				result <- smokeMetric{
					Transport:        "go-websocket",
					TargetLanguage:   targetLanguage,
					GateMetric:       "text",
					ConnectMs:        connectMs,
					SpeechOffsetMs:   speechOffsetMs,
					SpeechToTargetMs: time.Since(speechStartedAt).Milliseconds(),
					FirstDeltaBytes:  len([]byte(event.Delta)),
				}
				return
			}
			if event.Type == "session.output_audio.delta" && event.Delta != "" && (gateMetric == "audio" || gateMetric == "first") {
				result <- smokeMetric{
					Transport:        "go-websocket",
					TargetLanguage:   targetLanguage,
					GateMetric:       "audio",
					ConnectMs:        connectMs,
					SpeechOffsetMs:   speechOffsetMs,
					SpeechToTargetMs: time.Since(speechStartedAt).Milliseconds(),
					FirstDeltaBytes:  len([]byte(event.Delta)),
				}
				return
			}
		}
	}()

	if err := streamPCM(conn, pcmPath); err != nil {
		return smokeMetric{}, err
	}

	select {
	case metric := <-result:
		return metric, nil
	case err := <-errs:
		return smokeMetric{}, err
	case <-time.After(20 * time.Second):
		return smokeMetric{}, fmt.Errorf("timeout waiting for target %s output", gateMetric)
	}
}

func streamPCM(conn *websocket.Conn, pcmPath string) error {
	file, err := os.Open(pcmPath)
	if err != nil {
		return err
	}
	defer file.Close()

	const bytesPerSecond = 24_000 * 2
	chunkMs := intEnv("SMOKE_CHUNK_MS", 10)
	if chunkMs <= 0 {
		chunkMs = 10
	}
	chunkBytes := bytesPerSecond * chunkMs / 1000
	reader := bufio.NewReader(file)
	chunk := make([]byte, chunkBytes)
	ticker := time.NewTicker(time.Duration(chunkMs) * time.Millisecond)
	defer ticker.Stop()
	for {
		n, err := reader.Read(chunk)
		if n > 0 {
			audio := base64.StdEncoding.EncodeToString(chunk[:n])
			if err := conn.WriteJSON(clientEvent{Type: "session.input_audio_buffer.append", Audio: audio}); err != nil {
				return err
			}
			<-ticker.C
		}
		if err != nil {
			return nil
		}
	}
}

func waitForSessionUpdated(conn *websocket.Conn) error {
	if err := conn.SetReadDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return err
	}
	defer conn.SetReadDeadline(time.Time{})
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			return err
		}
		var event serverEvent
		if err := json.Unmarshal(data, &event); err != nil {
			continue
		}
		if event.Type == "error" {
			if event.Error != nil {
				return fmt.Errorf("%s", event.Error.Message)
			}
			return fmt.Errorf("realtime api error")
		}
		if event.Type == "session.updated" {
			return nil
		}
	}
}

func synthesizePCM(text string, rate string, voice string) (string, func(), error) {
	dir, err := os.MkdirTemp("", "co-translator-go-smoke")
	if err != nil {
		return "", nil, err
	}
	cleanup := func() { _ = os.RemoveAll(dir) }
	aiff := filepath.Join(dir, "speech.aiff")
	pcm := filepath.Join(dir, "speech.pcm")
	args := []string{"-r", rate, "-o", aiff}
	if voice != "" {
		args = append(args, "-v", voice)
	}
	args = append(args, text)
	if err := exec.Command("/usr/bin/say", args...).Run(); err != nil {
		cleanup()
		return "", nil, err
	}
	delayFilter := fmt.Sprintf("adelay=%d:all=1,apad=pad_dur=2", syntheticLeadingSilenceMs)
	if err := exec.Command("/opt/homebrew/bin/ffmpeg", "-y", "-i", aiff, "-af", delayFilter, "-ar", "24000", "-ac", "1", "-f", "s16le", pcm).Run(); err != nil {
		cleanup()
		return "", nil, err
	}
	return pcm, cleanup, nil
}

func detectSpeechOnsetMs(pcmPath string) (int64, error) {
	file, err := os.Open(pcmPath)
	if err != nil {
		return 0, err
	}
	defer file.Close()

	const sampleRate = 24_000
	const bytesPerSample = 2
	const chunkMs = 5
	const threshold = 0.012
	chunkBytes := sampleRate * bytesPerSample * chunkMs / 1000
	chunk := make([]byte, chunkBytes)
	elapsedMs := int64(0)
	for {
		n, err := file.Read(chunk)
		if n > 1 {
			sampleCount := n / bytesPerSample
			var sumSquares float64
			for index := 0; index < sampleCount; index += 1 {
				sample := int16(uint16(chunk[index*2]) | uint16(chunk[index*2+1])<<8)
				normalized := float64(sample) / 32768
				sumSquares += normalized * normalized
			}
			rms := sumSquares / float64(sampleCount)
			if rms >= threshold*threshold {
				return elapsedMs, nil
			}
			elapsedMs += chunkMs
		}
		if err != nil {
			return syntheticLeadingSilenceMs, nil
		}
	}
}

func getenv(key string, fallback string) string {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	return value
}

func intEnv(key string, fallback int) int {
	value := os.Getenv(key)
	if value == "" {
		return fallback
	}
	var parsed int
	if _, err := fmt.Sscanf(value, "%d", &parsed); err != nil {
		return fallback
	}
	return parsed
}

func loadEnvFiles(paths ...string) {
	for _, path := range paths {
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(data), "\n") {
			line = strings.TrimSpace(line)
			if line == "" || strings.HasPrefix(line, "#") {
				continue
			}
			key, value, ok := strings.Cut(line, "=")
			if !ok {
				continue
			}
			key = strings.TrimSpace(key)
			value = strings.Trim(strings.TrimSpace(value), `"'`)
			if key != "" && os.Getenv(key) == "" {
				_ = os.Setenv(key, value)
			}
		}
	}
}
