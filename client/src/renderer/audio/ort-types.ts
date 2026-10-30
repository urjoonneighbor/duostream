// Типы ONNX Runtime Web для ядер шумодава. Только типы: в Web Worker ort приходит из vendor/ort,
// в Node (scripts/test-denoiser.mts) — из пакета onnxruntime-web.
export type Ort = typeof import('onnxruntime-web');
export type OrtSession = import('onnxruntime-web').InferenceSession;
export type OrtTensor = import('onnxruntime-web').Tensor;
