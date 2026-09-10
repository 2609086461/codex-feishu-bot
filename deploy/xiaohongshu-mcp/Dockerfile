# syntax=docker/dockerfile:1.7

# Build the audited v2.5.0 source with our narrowly scoped login-session patch.
FROM golang:1.24 AS builder

ARG XHS_SOURCE_COMMIT=6583124dfda92312b6bc19a042a6acfae63fe498
WORKDIR /src
RUN git clone https://github.com/xpzouying/xiaohongshu-mcp.git . \
    && git checkout --detach "$XHS_SOURCE_COMMIT"

COPY deploy/xiaohongshu-mcp/login-device-verification.patch /tmp/login-device-verification.patch
RUN git apply --check /tmp/login-device-verification.patch \
    && git apply /tmp/login-device-verification.patch

ENV GOPROXY=https://proxy.golang.org,direct
RUN go test ./...
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 \
    go build -ldflags="-s -w -X main.version=v2.5.0-feishu-login-fix.1" -o /out/app .

# Keep the upstream browser and runtime dependencies, but replace only the Go
# service binary built from the pinned source above.
FROM xpzouying/xiaohongshu-mcp:v2.5.0@sha256:88e2603f324f567e0a254ed7a1e24d632a16eccc30e84ef3fb887e34a03d0fe3
COPY --from=builder /out/app /app/app

