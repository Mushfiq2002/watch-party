/// <reference types="vite/client" />

interface HTMLMediaElement {
  captureStream?(frameRate?: number): MediaStream;
}

interface HTMLVideoElement {
  webkitCaptureStream?(frameRate?: number): MediaStream;
}
