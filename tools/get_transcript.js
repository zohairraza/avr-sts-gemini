/**
 * get_transcript.js
 *
 * This tool retrieves the current conversation transcript for the session.
 */

// Tool definition
const name = "get_transcript";
const description = "Get the full transcript of the conversation so far. Should be offered to the user at the end of a successful call.";
const input_schema = {
  type: "object",
  properties: {},
  required: [],
};

/**
 * Handler for the get_transcript tool.
 *
 * @param {string} sessionUuid - The UUID of the current session.
 * @param {object} args - The arguments for the tool (not used in this case).
 * @param {object} context - The context of the tool, containing the transcripts map.
 * @returns {string} The formatted conversation transcript.
 */
async function handler(sessionUuid, args, context) {
  console.log("get_transcript tool called. Transcripts:", context.transcripts.get(sessionUuid));
  if (context.transcripts && context.transcripts.has(sessionUuid)) {
    const transcript = context.transcripts.get(sessionUuid);
    if (transcript.length === 0) {
      return "The transcript is currently empty.";
    }
    const formattedTranscript = transcript
      .map(entry => `[${entry.timestamp}] ${entry.speaker}: ${entry.text}`)
      .join('\n');
    return `Here is the transcript of our conversation:\n${formattedTranscript}`;
  }
  return "I'm sorry, I couldn't retrieve the transcript for this session.";
}


module.exports = {
  name,
  description,
  input_schema,
  handler,
};
