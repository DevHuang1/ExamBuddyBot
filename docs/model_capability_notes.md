# Model Capability Notes

## Groq official documentation

Groq’s vision documentation states that `qwen/qwen3.6-27b` accepts both text and image inputs, supports JSON mode, has a 131K-token context window, allows at most five images per request, and accepts image requests up to 20 MB. This supports ExamBuddyBot’s current strategy of sequentially batching exam-paper pages into groups of five.

Source: https://console.groq.com/docs/vision

Groq’s supported-model page lists `openai/gpt-oss-120b` as a production text model with a 131K-token context window and a maximum completion length of 65,536 tokens. The same page lists `qwen/qwen3.6-27b` as a preview multimodal model with a 131K-token context window, 16,384 maximum completion tokens, and a 20 MB maximum file size.

Source: https://console.groq.com/docs/models

Groq’s structured-output documentation states that strict JSON-schema output uses constrained decoding and is supported by `openai/gpt-oss-20b` and `openai/gpt-oss-120b`; it requires all fields to be required and `additionalProperties` to be false. ExamBuddyBot uses this for validated quiz-generation output.

Source: https://console.groq.com/docs/structured-outputs

## Hugging Face Transformers.js findings

The Hugging Face Transformers.js installation guide specifies the npm package `@huggingface/transformers`. Its official Node.js guide states that CommonJS applications can use the ESM-only library through dynamic `import()`, and recommends lazy singleton loading and an explicit cache directory for server-side inference.

Sources: https://huggingface.co/docs/transformers.js/en/installation and https://huggingface.co/docs/transformers.js/en/tutorials/node

The Transformers.js pipeline documentation states that `pipeline()` supports feature extraction and sentence similarity. Models must have ONNX weights to run in Transformers.js. It also notes that downloaded models are cached after the first load, which makes subsequent calls faster.

Source: https://huggingface.co/docs/transformers.js/en/pipelines

The enabled Hugging Face connector reports that `Xenova/all-MiniLM-L6-v2` is a `transformers.js`/ONNX feature-extraction model, licensed Apache-2.0. It is a suitable lightweight semantic-retrieval layer for ranking uploaded-source chunks before the stronger answer model produces the final answer.

Source: https://huggingface.co/Xenova/all-MiniLM-L6-v2
