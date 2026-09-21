/**
 * index.js
 * Entry point for Gemini Speech-to-Speech streaming WebSocket server.
 * This server handles real-time audio streaming between clients and Gemini's API,
 * performing necessary audio format conversions and WebSocket communication.
 *
 * Client Protocol:
 * - Send {"type": "init", "uuid": "uuid"} to initialize session
 * - Send {"type": "audio", "audio": "base64_encoded_audio"} to stream audio
 * - Receive {"type": "audio", "audio": "base64_encoded_audio"} for responses
 * - Receive {"type": "error", "message": "error_message"} for errors
 *
 * @author Agent Voice Response <info@agentvoiceresponse.com>
 * @see https://www.agentvoiceresponse.com
 */

const url = require("url"); // Added url import
const WebSocket = require("ws");
const { create, SRC_SINC_BEST_QUALITY, SRC_SINC_MEDIUM_QUALITY, SRC_SINC_FASTEST } = require("@alexanderolsen/libsamplerate-js");
const { GoogleGenAI, Modality, ThinkingLevel } = require("@google/genai");
const axios = require("axios");
const fs = require("fs").promises;

const path = require("path"); // Added path import
const { loadTools, getToolHandler } = require("./loadTools");

require("dotenv").config({ path: ".env.gem" });
require("dotenv").config({ path: ".env.google" });
require("dotenv").config(); // fallback to .env

// Custom logger with timestamps for troubleshooting delays
const logFile = "logs/avr-sts-gemini.log"; // Log to a file within the logs directory
const debugLogFile = "logs/avr-sts-gemini-debug.log"; // Debug log to a file within the logs directory

const log = (...args) => {
  const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg).join(' ');
  fs.appendFile(debugLogFile, `[${new Date().toISOString()}] ${message}\n`).catch(console.error);
  console.log(`[${new Date().toISOString()}]`, ...args);
};
const logError = (...args) => {
  const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg).join(' ');
  fs.appendFile(debugLogFile, `[${new Date().toISOString()}] ERROR: ${message}\n`).catch(console.error);
  console.error(`[${new Date().toISOString()}]`, ...args);
};
const logDebug = (...args) => {
  const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg).join(' ');
  fs.appendFile(debugLogFile, `[${new Date().toISOString()}] DEBUG: ${message}\n`).catch(console.error);
  console.debug(`[${new Date().toISOString()}]`, ...args);
};
const logInfo = (...args) => {
  const message = args.map(arg => typeof arg === 'object' ? JSON.stringify(arg, null, 2) : arg).join(' ');
  fs.appendFile(debugLogFile, `[${new Date().toISOString()}] INFO: ${message}\n`).catch(console.error);
  console.info(`[${new Date().toISOString()}]`, ...args);
};

const isTruthy = (value) =>
  ["1", "true", "yes", "on"].includes(String(value || "").toLowerCase());

/**
 * Returns true when Vertex AI (Google Cloud Console) mode is enabled.
 * Supports SDK-standard and AVR-prefixed env vars.
 */
const isVertexAiMode = () =>
  isTruthy(process.env.GOOGLE_GENAI_USE_VERTEXAI) ||
  isTruthy(process.env.GEMINI_USE_VERTEXAI);

/**
 * Creates a GoogleGenAI client for either Google AI Studio (API key) or Vertex AI.
 *
 * Vertex AI: set GOOGLE_GENAI_USE_VERTEXAI=true (or GEMINI_USE_VERTEXAI=true),
 * GOOGLE_CLOUD_PROJECT, GOOGLE_CLOUD_LOCATION, and configure ADC
 * (e.g. GOOGLE_APPLICATION_CREDENTIALS or gcloud application-default login).
 *
 * Google AI Studio: set GEMINI_API_KEY (or GOOGLE_API_KEY).
 */
const createGoogleGenAIClient = () => {
  if (isVertexAiMode()) {
    const project =
      process.env.GOOGLE_CLOUD_PROJECT || process.env.GEMINI_VERTEX_PROJECT;
    const location =
      process.env.GOOGLE_CLOUD_LOCATION || process.env.GEMINI_VERTEX_LOCATION;

    if (!project || !location) {
      throw new Error(
        "Vertex AI mode requires GOOGLE_CLOUD_PROJECT and GOOGLE_CLOUD_LOCATION " +
          "(or GEMINI_VERTEX_PROJECT and GEMINI_VERTEX_LOCATION)"
      );
    }

    const options = { vertexai: true, project, location };
    if (process.env.GEMINI_API_VERSION) {
      options.apiVersion = process.env.GEMINI_API_VERSION;
    }

    log(
      `Google GenAI client: Vertex AI (project=${project}, location=${location})`
    );
    return new GoogleGenAI(options);
  }

  const apiKey =
    process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "";
  if (!apiKey) {
    throw new Error(
      "Google AI Studio mode requires GEMINI_API_KEY (or GOOGLE_API_KEY). " +
        "For Vertex AI, set GOOGLE_GENAI_USE_VERTEXAI=true with project and location."
    );
  }

  const options = { apiKey };
  if (process.env.GEMINI_API_VERSION) {
    options.apiVersion = process.env.GEMINI_API_VERSION;
  } else {
    options.apiVersion = "v1alpha";
  }

  log("Google GenAI client: Google AI Studio (API key)");
  return new GoogleGenAI(options);
};


function substituteEnvVars(str) {
  if (!str) return str;
  return str.replace(/\$\{\w+\}/g, (match, varName) => {
    return process.env[varName] || match;
  });
}

function extractInitialPrompt(systemInstruction) {
  const regex = /## Phase 1: The Gatekeeper \(Navigation\)\n(?:.*\n)*?- \*\*PROMPT\*\*:\s*\"(.*?)\"/;
  const match = systemInstruction.match(regex);
  if (match && match[1]) {
    return match[1];
  }
  return "Hello, how can I help you today?"; // Default if not found
}

// Global map to store transcripts for each session
const transcripts = new Map();
log("Global transcripts map initialized.");

// Global map to store file handles for each session's audio streams
const audioFileHandles = new Map();

/**
 * Saves an audio chunk to a date-wise, bot-wise directory structure.
 * Appends to a file specific to the session and speaker type.
 *
 * @param {string} type - 'user' or 'ai'
 * @param {string} sessionUuid - The UUID of the current session.
 * @param {Buffer} chunkBuffer - The audio chunk to save.
 */
const saveAudioChunk = async (type, sessionUuid, chunkBuffer) => {
  const audioSaveDir = process.env.AUDIO_SAVE_DIR || "./saved_audios";
  const botName = process.env.BOT_NAME || "gemini_bot";
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD

  const sessionDir = path.join(audioSaveDir, today, botName, sessionUuid);
  const filePath = path.join(sessionDir, `${type}_audio.pcm`);

  // Ensure directory exists
  await fs.mkdir(sessionDir, { recursive: true });

  // Append chunk to file. Use a global map to store file handles
  // to avoid opening/closing for each chunk and ensure sequential writes.
  const handleKey = `${sessionUuid}-${type}`;
  let fileHandle = audioFileHandles.get(handleKey);

  if (!fileHandle) {
    fileHandle = await fs.open(filePath, "a"); // Open in append mode
    audioFileHandles.set(handleKey, fileHandle);
  }

  await fileHandle.write(chunkBuffer);
};

/**
 * Stream Processing
 */

// Global audio resamplers - created once and shared across all connections
let globalDownsampler = null;
let globalUpsampler = null;

/**
 * Initializes global audio resamplers for format conversion.
 * Called once at server startup.
 */
const initializeResamplers = async () => {
  try {
    let resamplerQuality = SRC_SINC_MEDIUM_QUALITY; // Default
    if (process.env.RESAMPLER_QUALITY === "SRC_SINC_BEST_QUALITY") {
      resamplerQuality = SRC_SINC_BEST_QUALITY;
    } else if (process.env.RESAMPLER_QUALITY === "SRC_SINC_FASTEST") {
      resamplerQuality = SRC_SINC_FASTEST;
    }
    log("Using resampler quality:", process.env.RESAMPLER_QUALITY || "SRC_SINC_MEDIUM_QUALITY");

    globalDownsampler = await create(1, 24000, 8000, resamplerQuality); //1 channel, 24kHz to 8kHz
    globalUpsampler = await create(1, 8000, 16000, resamplerQuality); //1 channel, 8kHz to 16kHz
    log("Global audio resamplers initialized")
  } catch (error) {
    logError("Error initializing resamplers:", error);
    process.exit(1);
  }
};

const connectToGeminiSdk = async (sessionUuid, systemInstruction, callbacks) => {
  log(`[DEBUG] Starting Gemini connection for session ${sessionUuid}`);
  const model =
    process.env.GEMINI_MODEL ||
    "gemini-2.5-flash-native-audio-preview-12-2025";
  log(`[DEBUG] Using model: ${model}`);

  const ai = createGoogleGenAIClient();

  const config = {
    model: model, // Model as a top-level property
    responseModalities: [Modality.AUDIO], // Also top-level
    systemInstruction: { parts: [{ text: systemInstruction }] }, // Use the passed systemInstruction
    outputAudioTranscription: {},
    inputAudioTranscription: {}, // Enable input transcription for user audio
  };

  // Temperature configuration (0.1 - 0.4 recommended for voice agents to prevent hallucinations)
  if (process.env.GEMINI_TEMPERATURE !== undefined) {
    config.temperature = parseFloat(process.env.GEMINI_TEMPERATURE);
    log(`Gemini temperature set to: ${config.temperature}`);
  }

  // Context window compression to prevent 128k context blow-out / session disconnections
  const triggerTokens = parseInt(process.env.CONTEXT_WINDOW_TRIGGER_TOKENS || "80000", 10);
  const targetTokens = parseInt(process.env.CONTEXT_WINDOW_TARGET_TOKENS || "4000", 10);
  if (triggerTokens > 0) {
    config.contextWindowCompression = {
      triggerTokens: triggerTokens,
      slidingWindow: {
        targetTokens: targetTokens,
      },
    };
    log(`Context window compression enabled (triggerTokens: ${triggerTokens}, targetTokens: ${targetTokens})`);
  }

  // Add speechConfig (previously ttsConfig)
  log(`GEMINI_TTS_VOICE_NAME from env: ${process.env.GEMINI_TTS_VOICE_NAME}`);
  config.speechConfig = { // Now a direct property of config
    voiceConfig: {
      prebuiltVoiceConfig: {
        voiceName: process.env.GEMINI_TTS_VOICE_NAME || "en-US-Standard-C", // Default voice
      }
    },
  };

  // Enable Proactive Audio if environment variable is set to 'true'
  if (process.env.GEMINI_ENABLE_PROACTIVE_AUDIO === 'true') {
    config.proactivity = {
      proactiveAudio: true,
    };
    log("Proactive Audio enabled.");
  }

  // Enable Affective Dialog if environment variable is set to 'true'
  if (process.env.GEMINI_ENABLE_AFFECTIVE_DIALOG === 'true') {
    config.enableAffectiveDialog = true;
    log("Affective Dialog enabled.");
  }

  // VAD configuration - reduced for faster response
  config.realtimeInputConfig = {
    automaticActivityDetection: {
      silenceDurationMs: 5000,
    },
    activityHandling: "NO_INTERRUPTION",
  };
  log("VAD enabled with 5s silence duration.");

  // Enable Proactive Audio for faster responses
  config.proactivity = {
    proactiveAudio: true,
  };
  log("Proactive Audio enabled");

  // Upstream thinking configuration (default: MINIMAL level, 0 budget for zero voice latency)
  config.thinkingConfig = {
    thinkingLevel: process.env.GEMINI_THINKING_LEVEL || ThinkingLevel.MINIMAL,
    thinkingBudget: +process.env.GEMINI_THINKING_BUDGET || 0,
  };
  log(`Thinking configured (budget: ${config.thinkingConfig.thinkingBudget}, level: ${config.thinkingConfig.thinkingLevel})`);

  // Load tools
  try {
    const tools = loadTools();
    log("Loaded tools details:", tools.map(tool => tool.name));
    config.tools = [{ functionDeclarations: tools }];
    log(`Loaded ${tools.length} tools for Gemini.`);
  } catch (error) {
    logError(`Error loading tools for Gemini: ${error.message}`);
  }

  log("Gemini Session Config:", JSON.stringify(config, null, 2));
  log("Gemini Session Model:", model);

  log(`[DEBUG] About to call ai.live.connect`);
  log(`[DEBUG] Calling ai.live.connect with config`);

  try {
    const session = await ai.live.connect({
      model: model, // Use local model variable
      callbacks: callbacks, // SDK will call onopen/onerror/onmessage
      config: config,
    });
    log(`[DEBUG] ai.live.connect returned, session ready`);
    return session; // Return just the session object
   } catch (error) {
    logError(`Error during ai.live.connect: ${error.message}`);
    throw new Error(`Failed to establish Gemini session: ${error.message}`);
  }
};

/**
 * Handles incoming client WebSocket connection and manages communication with Gemini Live API.
 * Implements buffering for audio chunks received before WebSocket connection is established.
 *
 * @param {WebSocket} clientWs - Client WebSocket connection
 */
const handleClientConnection = (clientWs) => {
  log("New client WebSocket connection received")
  let sessionUuid = null;
  let systemInstruction = "You are a helpful assistant."; // Default

  let audioBuffer8k = [];
  let session = null;
  let audioFrames = [];


  /**
   * Processes Gemini audio chunks by downsampling and extracting frames.
   * Converts 24kHz audio to 8kHz and extracts 20ms frames (160 samples).
   *
   * @param {Buffer} inputBuffer - Raw audio buffer from Gemini
   * @returns {Buffer[]} Array of 20ms audio frames
   */
  function processGeminiAudioChunk(inputBuffer) {
    // Convert Buffer to Int16Array for processing
    const inputSamples = new Int16Array(
      inputBuffer.buffer,
      inputBuffer.byteOffset,
      inputBuffer.length / 2,
    );

    // Downsample from 24kHz to 8kHz using global downsampler
    const downsampledSamples = globalDownsampler.full(inputSamples);

    // Accumulate samples in buffer
    audioBuffer8k = audioBuffer8k.concat(Array.from(downsampledSamples));

    // Extract 20ms frames (160 samples = 320 bytes)
    const audioFrames = [];
    while (audioBuffer8k.length >= 160) {
      const frame = audioBuffer8k.slice(0, 160);
      audioBuffer8k = audioBuffer8k.slice(160);

      // Convert to PCM16LE Buffer (320 bytes)
      audioFrames.push(Buffer.from(Int16Array.from(frame).buffer));
    }

    return audioFrames;
  }

  /**
   * Converts 8kHz audio to 16kHz for sending to Gemini API.
   *
   * @param {Buffer} inputBuffer - 8kHz audio buffer
   * @returns {Buffer} 16kHz audio buffer
   */
  function convert8kTo16k(inputBuffer) {
    const inputSamples = new Int16Array(
      inputBuffer.buffer,
      inputBuffer.byteOffset,
      inputBuffer.length / 2,
    );
    const upsampledSamples = globalUpsampler.full(inputSamples);
    return Buffer.from(Int16Array.from(upsampledSamples).buffer);
  }

  // Handle client WebSocket messages
  clientWs.on("message", async (data) => {
    try {
      const message = JSON.parse(data);
      switch (message.type) {
        case "init":
          sessionUuid = message.uuid;
          log("Session UUID:", sessionUuid);
          transcripts.set(sessionUuid, []); // Initialize transcript for this session
          log(`Transcript initialized for session ${sessionUuid}.`);

          // Load dynamic instructions if configured
          const loadInstructions = async () => {
            if (process.env.GEMINI_INSTRUCTIONS) {
              systemInstruction = substituteEnvVars(process.env.GEMINI_INSTRUCTIONS);
              log("Using GEMINI_INSTRUCTIONS from environment variable")
            } else if (process.env.GEMINI_URL_INSTRUCTIONS) {
              try {
                const startTime = Date.now();
                log(`Fetching instructions from ${process.env.GEMINI_URL_INSTRUCTIONS} for session ${sessionUuid}`);
                const response = await axios.get(process.env.GEMINI_URL_INSTRUCTIONS, {
                  headers: {
                    "Content-Type": "application/json",
                    "X-AVR-UUID": sessionUuid,
                  },
                });
                const fetchTime = Date.now() - startTime;
                log(`Instructions fetched in ${fetchTime}ms from GEMINI_URL_INSTRUCTIONS`);
                const data = await response.data;
                log("Full instruction data:", JSON.stringify(data, null, 2));
                systemInstruction = data.system;
              } catch (error) {
                logError(
                  `Error loading instructions from ${process.env.GEMINI_URL_INSTRUCTIONS}: ${error.message}`,
                );
                // Keep default
              }
            } else if (process.env.GEMINI_FILE_INSTRUCTIONS) {
              try {
                const data = await fs.readFile(
                  process.env.GEMINI_FILE_INSTRUCTIONS,
                  "utf8",
                );
                log("Using GEMINI_FILE_INSTRUCTIONS from environment variable")
                log(data);
                systemInstruction = data;
              } catch (error) {
                logError(
                  `Error loading instructions from ${process.env.GEMINI_FILE_INSTRUCTIONS}: ${error.message}`,
                );
                // Keep default
              }
            } else {
              log("Using default instructions");
            }
          };

          // Load instructions then initialize connection
          loadInstructions().then(() => {
            initializeGeminiConnection(systemInstruction);
          }).catch((err) => {
            logError("Failed to load instructions:", err);
            initializeGeminiConnection(systemInstruction); // Use default
          });
          break;

        case "audio":
          // Handle audio data from client
          if (message.audio && session) {
            const audioBuffer = Buffer.from(message.audio, "base64");
            // Save user audio (8kHz PCM from client)
            if (process.env.SAVE_AUDIO_CHUNKS === 'true') {
              saveAudioChunk("user", sessionUuid, audioBuffer).catch(console.error);
            }
            const upsampledAudio = convert8kTo16k(audioBuffer);
            session.sendRealtimeInput({
              audio: {
                data: upsampledAudio.toString("base64"),
                mimeType: "audio/pcm;rate=16000",
              },
            });
          }
          break;

        default:
          log("Unknown message type from client:", message.type);
          break;
      }
    } catch (error) {
      logError("Error processing client message:", error);
    }
  });

  // Initialize Gemini connection
  const initializeGeminiConnection = async (systemInstruction) => {
    try {
      // session is now the Gemini SDK's session object
      session = await connectToGeminiSdk(sessionUuid, systemInstruction, {
        onopen: function () {
          logDebug("Gemini Session Opened");
        },
        onmessage: async function (message) {
          if (process.env.DEBUG_LOGS === 'true') {
            // Only log message if it doesn't contain inlineData (audio chunks)
            const hasInlineData = message.serverContent?.modelTurn?.parts?.some(part => part.inlineData);
            if (!hasInlineData) {
              log("Gemini Message:", JSON.stringify(message, null, 2));
            }
          }

          // Check for setup complete
          if (message.setupComplete) {
            log("Setup complete, session ready");
            return;
          }

          // Handle AudioStreamEnd event for silence detection
          if (message.serverContent?.audioStreamEnd) {
            log("INFO: AudioStreamEnd event received. Silence detected.");
            session.sendRealtimeInput({
              text: "Are we still connected?",
            });
            return; // No further processing for this message
          }

          // ASR output from Gemini (user's speech) - input transcription
          if (message.text) {
            if (transcripts.has(sessionUuid)) {
              transcripts.get(sessionUuid).push({
                speaker: "User",
                text: message.text,
                timestamp: new Date().toISOString(),
              });
              log("User says:", message.text);
              log("Transcripts:", transcripts.get(sessionUuid));
             }
           }

           // Handle output transcription (AI speech)
           if (message.serverContent?.outputTranscription) {
             log("Output Transcription:", message.serverContent.outputTranscription);
             if (transcripts.has(sessionUuid)) {
               transcripts.get(sessionUuid).push({
                 speaker: "AI",
                 text: message.serverContent.outputTranscription.text,
                 timestamp: new Date().toISOString(),
               });
             }
           }

           // Handle input transcription (user speech)
           if (message.serverContent?.inputTranscription) {
             log("Input Transcription:", message.serverContent.inputTranscription);
             if (transcripts.has(sessionUuid)) {
               transcripts.get(sessionUuid).push({
                 speaker: "User",
                 text: message.serverContent.inputTranscription.text,
                 timestamp: new Date().toISOString(),
               });
             }
           }

           // Model Turn with parts (audio + text output)
          if (message.serverContent?.modelTurn?.parts) {
            const modelTurn = message.serverContent.modelTurn;
            log("Model Turn received:", modelTurn);
            const parts = modelTurn.parts;
            log("Parts count:", parts?.length);
            for (let i = 0; i < parts?.length; i++) {
              const part = parts[i];
              if (process.env.DEBUG_LOGS === 'true' && !part?.inlineData) log(`Part ${i}:`, JSON.stringify(part, null, 2));

              // Handle Audio
              if (part?.inlineData) {
                const inlineData = part.inlineData;
                // log(
                //   "Processing audio chunk, size:",
                //   inlineData.data?.length,
                // );
                const audioChunk = Buffer.from(inlineData.data, "base64");
                // Save AI audio (24kHz PCM from Gemini)
                if (process.env.SAVE_AUDIO_CHUNKS === 'true') {
                  saveAudioChunk("ai", sessionUuid, audioChunk).catch(console.error);
                }
                audioFrames = processGeminiAudioChunk(audioChunk);
                // Send audio frames to client
                audioFrames.forEach((frame) => {
                  clientWs.send(
                    JSON.stringify({
                      type: "audio",
                      audio: frame.toString("base64"),
                    }),
                  );
                });
              }
              // Text content from Gemini's response (AI speaking) - output transcription
              if (part?.text) {
                log("AI text transcription received:", part.text);
                if (transcripts.has(sessionUuid)) {
                  transcripts.get(sessionUuid).push({
                    speaker: "AI",
                    text: part.text,
                    timestamp: new Date().toISOString(),
                  });
                  log("AI says:", part.text);
                }
              }
            }
          } else if (message.toolCall?.functionCalls) {
            log(
              "Gemini Session Tool Calls:",
              message.toolCall.functionCalls,
            );
            const functionResponses = [];
            for (const fc of message.toolCall.functionCalls) {
              const handler = getToolHandler(fc.name);
              const obj = {
                id: fc.id,
                name: fc.name,
                response: { result: "" },
              };
              if (!handler) {
                obj.response.result = `I'm sorry, I cannot retrieve the requested information.`;
                functionResponses.push(obj);
              } else {
                obj.response.result = await handler(sessionUuid, fc.args, {
                  transcripts,
                });
                functionResponses.push(obj);
              }
              log("Gemini Session Tool Response:", obj.response.result);
            }

            session.sendToolResponse({ functionResponses });
          } else if (message.serverContent?.interrupted) {
            log("Gemini Session Interruption");
            audioFrames = [];
            clientWs.send(JSON.stringify({ type: "interruption" }));
          } else { 
            // log("Gemini Session Message:", message);
          }
        },
        onerror: function (e) {
          logError("Gemini Session Error:", e);
          clientWs.send(
            JSON.stringify({
              type: "error",
              message: e.message,
            }),
          );
        },
        onclose: function (event) {
          logInfo(
            "Gemini Session Closed. Code:",
            event?.code,
            "Reason:",
            event?.reason,
          );
          clientWs.close();
        },
      });
      // begin gemini conversation
      const rawInitialPrompt = extractInitialPrompt(systemInstruction);
      const initialPrompt = substituteEnvVars(rawInitialPrompt);
      session.sendRealtimeInput({
        text: initialPrompt,
      });

    } catch (error) {
      logError("Error initializing Gemini connection:", error);
      const message = error?.message || "Failed to initialize Gemini connection";
      clientWs.send(
        JSON.stringify({
          type: "error",
          message: message,
        }),
      );
    }
  };

  // Handle client WebSocket close
  clientWs.on("close", () => {
    log("Client WebSocket connection closed")
    cleanup();
  });

  clientWs.on("error", (err) => {
    logError("Client WebSocket error:", err);
    cleanup();
  });

  /**
   * Cleans up resources, closes connections, and saves final transcript.
   */
  async function cleanup() {
    if (session) session.close();
    if (clientWs) clientWs.close();

    // Close any open audio file handles for this session
    const handleUserKey = `${sessionUuid}-user`;
    if (audioFileHandles.has(handleUserKey)) {
      await audioFileHandles.get(handleUserKey).close();
      audioFileHandles.delete(handleUserKey);
      log(`User audio file handle for session ${sessionUuid} closed.`);
    }

    const handleAiKey = `${sessionUuid}-ai`;
    if (audioFileHandles.has(handleAiKey)) {
      await audioFileHandles.get(handleAiKey).close();
      audioFileHandles.delete(handleAiKey);
      log(`AI audio file handle for session ${sessionUuid} closed.`);
    }

    if (sessionUuid && transcripts.has(sessionUuid)) {
      const finalTranscript = transcripts.get(sessionUuid);
      const logFilePath = `logs/transcript-${sessionUuid}.txt`;

      const formattedTranscript = finalTranscript
        .map((entry) => `[${entry.timestamp}] ${entry.speaker}: ${entry.text}`)
        .join("\n");

      try {
        await fs.writeFile(logFilePath, formattedTranscript);
        log(
          `Transcript for session ${sessionUuid} saved to ${logFilePath}`,
        );
      } catch (error) {
        logError(
          `Failed to save transcript for session ${sessionUuid}:`,
          error,
        );
      } finally {
        transcripts.delete(sessionUuid);
        log(
          `Transcript for session ${sessionUuid} cleared from memory.`,
        );
      }
    }
  }
};

/**
 * Global cleanup function to destroy resamplers when process is terminated.
 */
const cleanupGlobalResources = () => {
  log("Cleaning up global resources...");
  if (globalDownsampler) {
    globalDownsampler.destroy();
    globalDownsampler = null;
  }
  if (globalUpsampler) {
    globalUpsampler.destroy();
    globalUpsampler = null;
  }
  log("Global resources cleaned up")
};

// Handle process termination signals
process.on("SIGINT", () => {
  log("Received SIGINT, shutting down gracefully...");
  cleanupGlobalResources();
  process.exit(0);
});

process.on("SIGTERM", () => {
  log("Received SIGTERM, shutting down gracefully...");
  cleanupGlobalResources();
  process.exit(0);
});

// Initialize resamplers and start server
const startServer = async () => {
  try {
    await initializeResamplers();

    // Create WebSocket server
    const PORT = process.env.PORT || 6037;
    const wss = new WebSocket.Server({ port: PORT });

    wss.on("connection", (clientWs, request) => { // Added 'request' parameter
      log("New client connected")

      // Parse query parameters from the WebSocket URL
      const query = url.parse(request.url, true).query;
      log("WebSocket URL Query Parameters:", query);

      // Set specific query parameters as process.env variables
      // These correspond to the dynamic variables passed from Asterisk via AudioSocket 'vars'
      const dynamicVarsToSet = [
        "BUSINESS_NAME",
        "WEBSITE",
        "MAPS_URL",
        "COMMENTS",
        "SUBURB_LOCATION",
        "COMPETITOR_NAME",
      ];

      for (const varName of dynamicVarsToSet) {
        if (query[varName]) {
          process.env[varName.toUpperCase()] = query[varName];
          log(`Set process.env.${varName.toUpperCase()}=${query[varName]}`);
        }
      }

      handleClientConnection(clientWs);
    });

    log(
      `Gemini Speech-to-Speech WebSocket server running on port ${PORT}`,
    );
  } catch (error) {
    logError("Failed to start server:", error);
    process.exit(1);
  }
};

// Start the server
startServer();
