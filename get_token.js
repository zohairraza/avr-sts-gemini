// gemini/avr-sts-gemini/get_token.js
const { getAccessToken } = require('./utils/google_calendar_helper');

const code = process.argv[2];

if (!code) {
  console.error("Please provide the authorization code as a command-line argument.");
  process.exit(1);
}

getAccessToken(code).then(() => {
  console.log("Successfully generated token.json");
}).catch(err => {
  console.error("Error generating token:", err);
});
