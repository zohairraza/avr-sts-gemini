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

const WebSocket = require("ws");
const { create } = require("@alexanderolsen/libsamplerate-js");
const { GoogleGenAI, Modality } = require("@google/genai");
const axios = require("axios");
const fs = require("fs").promises;
const path = require("path"); // Added path import
const { loadTools, getToolHandler } = require("./loadTools");

require("dotenv").config();

// Global map to store transcripts for each session
const transcripts = new Map();
console.log("Global transcripts map initialized.");

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
    globalDownsampler = await create(1, 24000, 8000); //1 channel, 24kHz to 8kHz
    globalUpsampler = await create(1, 8000, 16000); //1 channel, 8kHz to 16kHz
    console.log("Global audio resamplers initialized");
  } catch (error) {
    console.error("Error initializing resamplers:", error);
    process.exit(1);
  }
};

const connectToGeminiSdk = async (sessionUuid, callbacks) => {
  const model =
    process.env.GEMINI_MODEL ||
    "gemini-live-2.5-flash-preview-native-audio-12-2025";

  const config = {
    responseModalities: [Modality.AUDIO],
    systemInstruction: "You are a helpful assistant.",
  };

  if (process.env.GEMINI_INSTRUCTIONS) {
    config.systemInstruction = process.env.GEMINI_INSTRUCTIONS;
    console.log("Using GEMINI_INSTRUCTIONS from environment variable");
  } else if (process.env.GEMINI_URL_INSTRUCTIONS) {
    try {
      const response = await axios.get(process.env.GEMINI_URL_INSTRUCTIONS, {
        headers: {
          "Content-Type": "application/json",
          "X-AVR-UUID": sessionUuid,
        },
      });
      console.log("Instructions loaded from GEMINI_URL_INSTRUCTIONS");
      const data = await response.data;
      console.log(data);
      config.systemInstruction = data.system;
    } catch (error) {
      console.error(
        `Error loading instructions from ${process.env.GEMINI_URL_INSTRUCTIONS}: ${error.message}`,
      );
    }
  } else if (process.env.GEMINI_FILE_INSTRUCTIONS) {
    try {
      const data = await fs.readFile(
        process.env.GEMINI_FILE_INSTRUCTIONS,
        "utf8",
      );
      console.log("Using GEMINI_FILE_INSTRUCTIONS from environment variable");
      console.log(data);
      config.systemInstruction = data;
    } catch (error) {
      console.error(
        `Error loading instructions from ${process.env.GEMINI_FILE_INSTRUCTIONS}: ${error.message}`,
      );
    }
  } else {
    console.log("Using default instructions");
    config.systemInstruction =
      "You are a helpful assistant and answer in a friendly tone.";
  }

  try {
    const tools = loadTools();
    config.tools = [{ functionDeclarations: tools }];
    console.log(`Loaded ${tools.length} tools for Gemini.`);
  } catch (error) {
    console.error(`Error loading tools for Gemini: ${error.message}`);
  }

  console.log("Gemini Session Config:", config);
  console.log("Gemini Session Model:", model);

  const ai = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY || "",
    apiVersion: "v1alpha",
  });

  const session = await ai.live.connect({
    model: model,
    callbacks,
    config,
  });

  return session;
};

/**
 * Handles incoming client WebSocket connection and manages communication with Gemini Live API.
 * Implements buffering for audio chunks received before WebSocket connection is established.
 *
 * @param {WebSocket} clientWs - Client WebSocket connection
 */
const handleClientConnection = (clientWs) => {
  console.log("New client WebSocket connection received");
  let sessionUuid = null;

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
          console.log("Session UUID:", sessionUuid);
          transcripts.set(sessionUuid, []); // Initialize transcript for this session
          console.log(`Transcript initialized for session ${sessionUuid}.`);
          // Initialize Gemini connection when client is ready
          initializeGeminiConnection();
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
          console.log("Unknown message type from client:", message.type);
          break;
      }
    } catch (error) {
      console.error("Error processing client message:", error);
    }
  });

  // Initialize Gemini connection
  const initializeGeminiConnection = async () => {
    try {
      session = await connectToGeminiSdk(sessionUuid, {
        onopen: function () {
          console.debug("Gemini Session Opened");
        },
        onmessage: async function (message) {
          console.log("Gemini Message:", JSON.stringify(message, null, 2));

          // Check for setup complete
          if (message.setupComplete) {
            console.log("Setup complete, session ready");
            return;
          }

          // ASR output from Gemini (user's speech) - input transcription
          if (message.text) {
            if (transcripts.has(sessionUuid)) {
              transcripts.get(sessionUuid).push({
                speaker: "User",
                text: message.text,
                timestamp: new Date().toISOString(),
              });
              console.log("User says:", message.text);
              console.log("Transcripts:", transcripts.get(sessionUuid));
            }
          }

          // Model Turn with parts (audio + text output)
          if (message.serverContent?.modelTurn?.parts) {
            const modelTurn = message.serverContent.modelTurn;
            console.log("Model Turn received:", modelTurn);
            const parts = modelTurn.parts;
            console.log("Parts count:", parts?.length);
            for (let i = 0; i < parts?.length; i++) {
              const part = parts[i];
              console.log(`Part ${i}:`, JSON.stringify(part, null, 2));

              // Handle Audio
              if (part?.inlineData) {
                const inlineData = part.inlineData;
                console.log(
                  "Processing audio chunk, size:",
                  inlineData.data?.length,
                );
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
                console.log("AI text transcription received:", part.text);
                if (transcripts.has(sessionUuid)) {
                  transcripts.get(sessionUuid).push({
                    speaker: "AI",
                    text: part.text,
                    timestamp: new Date().toISOString(),
                  });
                  console.log("AI says:", part.text);
                }
              }
            }
          } else if (message.toolCall?.functionCalls) {
            console.log(
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
              console.log("Gemini Session Tool Response:", obj.response.result);
            }

            session.sendToolResponse({ functionResponses });
          } else if (message.serverContent?.interrupted) {
            console.log("Gemini Session Interruption");
            audioFrames = [];
            clientWs.send(JSON.stringify({ type: "interruption" }));
          } else {
            // console.log("Gemini Session Message:", message);
          }
        },
        onerror: function (e) {
          console.error("Gemini Session Error:", e);
          clientWs.send(
            JSON.stringify({
              type: "error",
              message: e.message,
            }),
          );
        },
        onclose: function (event) {
          console.info(
            "Gemini Session Closed. Code:",
            event.code,
            "Reason:",
            event.reason,
          );
          clientWs.close();
        },
      });
      // begin gemini conversation
      session.sendRealtimeInput({
        text: "Please start the conversation.",
      });
    } catch (error) {
      console.error("Error initializing Gemini connection:", error);
      clientWs.send(
        JSON.stringify({
          type: "error",
          message: "Failed to initialize Gemini connection",
        }),
      );
    }
  };

  // Handle client WebSocket close
  clientWs.on("close", () => {
    console.log("Client WebSocket connection closed");
    cleanup();
  });

  clientWs.on("error", (err) => {
    console.error("Client WebSocket error:", err);
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
      console.log(`User audio file handle for session ${sessionUuid} closed.`);
    }

    const handleAiKey = `${sessionUuid}-ai`;
    if (audioFileHandles.has(handleAiKey)) {
      await audioFileHandles.get(handleAiKey).close();
      audioFileHandles.delete(handleAiKey);
      console.log(`AI audio file handle for session ${sessionUuid} closed.`);
    }

    if (sessionUuid && transcripts.has(sessionUuid)) {
      const finalTranscript = transcripts.get(sessionUuid);
      const logFilePath = `logs/transcript-${sessionUuid}.txt`;

      const formattedTranscript = finalTranscript
        .map((entry) => `[${entry.timestamp}] ${entry.speaker}: ${entry.text}`)
        .join("\n");

      try {
        await fs.writeFile(logFilePath, formattedTranscript);
        console.log(
          `Transcript for session ${sessionUuid} saved to ${logFilePath}`,
        );
      } catch (error) {
        console.error(
          `Failed to save transcript for session ${sessionUuid}:`,
          error,
        );
      } finally {
        transcripts.delete(sessionUuid);
        console.log(
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
  console.log("Cleaning up global resources...");
  if (globalDownsampler) {
    globalDownsampler.destroy();
    globalDownsampler = null;
  }
  if (globalUpsampler) {
    globalUpsampler.destroy();
    globalUpsampler = null;
  }
  console.log("Global resources cleaned up");
};

// Handle process termination signals
process.on("SIGINT", () => {
  console.log("Received SIGINT, shutting down gracefully...");
  cleanupGlobalResources();
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("Received SIGTERM, shutting down gracefully...");
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

    wss.on("connection", (clientWs) => {
      console.log("New client connected");
      handleClientConnection(clientWs);
    });

    console.log(
      `Gemini Speech-to-Speech WebSocket server running on port ${PORT}`,
    );
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
};

// Start the server
startServer();
