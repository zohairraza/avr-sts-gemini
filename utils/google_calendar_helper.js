// gemini/avr-sts-gemini/utils/google_calendar_helper.js

const { google } = require("googleapis");
const fs = require("fs").promises;
const path = require("path");

require("dotenv").config({ path: path.resolve(__dirname, '../../../.env') });

const TOKEN_PATH = path.join(__dirname, "token.json");

// Check if the required environment variables are loaded
if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET || !process.env.GOOGLE_REDIRECT_URI) {
    throw new Error("Missing required Google Calendar environment variables (GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, GOOGLE_REDIRECT_URI). Please check your .env file in the root directory.");
}

/**
 * Creates an OAuth2 client with the given credentials.
 * @returns {google.auth.OAuth2} The OAuth2 client.
 */
function createOAuth2Client() {
  return new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
}

/**
 * Generates an authorization URL for the user to grant permissions.
 * @returns {string} The authorization URL.
 */
function getAuthorizationUrl() {
  const oAuth2Client = createOAuth2Client();
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: "offline",
    scope: ["https://www.googleapis.com/auth/calendar"],
  });
  return authUrl;
}

/**
 * Gets the access token from the authorization code and saves it.
 * This is a one-time setup step.
 * @param {string} code The authorization code from the user's redirect.
 */
async function getAccessToken(code) {
  const oAuth2Client = createOAuth2Client();
  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);
  // Store the new tokens to disk for later use
  await fs.writeFile(TOKEN_PATH, JSON.stringify(tokens));
  console.log("Token stored to", TOKEN_PATH);
  return oAuth2Client;
}

/**
 * Loads the saved credentials and returns an authorized OAuth2 client.
 * If credentials are not available or expired, it will guide the user to authorize.
 * @returns {Promise<google.auth.OAuth2|null>} The authorized OAuth2 client or null.
 */
async function getAuthorizedClient() {
  const oAuth2Client = createOAuth2Client();
  try {
    const token = await fs.readFile(TOKEN_PATH);
    const credentials = JSON.parse(token);
    oAuth2Client.setCredentials(credentials);

    // Check if the token is expired and refresh if needed
    if (oAuth2Client.isTokenExpiring()) {
      if (credentials.refresh_token) {
        const newTokens = await oAuth2Client.refreshAccessToken();
        oAuth2Client.setCredentials(newTokens.credentials);
        await fs.writeFile(TOKEN_PATH, JSON.stringify(newTokens.credentials));
        console.log("Token refreshed and stored.");
      } else {
        console.log("Token is expiring but no refresh_token available, using current token.");
      }
    }
    return oAuth2Client;
  } catch (error) {
    console.error("Error loading credentials:", error);
    console.log("Please authorize the application by visiting the following URL and then running the getAccessToken function with the provided code:");
    console.log(getAuthorizationUrl());
    return null;
  }
}

/**
 * Checks availability on the Google Calendar.
 * @param {string} start_time The start time of the event in ISO 8601 format.
 * @param {number} duration_minutes The duration of the event in minutes.
 * @returns {Promise<string>} A message indicating if the slot is available.
 */
async function checkAvailability(date, time, duration_minutes) {
   const oAuth2Client = await getAuthorizedClient();
   if (!oAuth2Client) {
     return "Google Calendar is not authorized. Please authorize the application first.";
   }
   const calendar = google.calendar({ version: "v3", auth: oAuth2Client });

   // Assume input date and time are for Europe/Amsterdam timezone.
   // For December 2025, Europe/Amsterdam uses Central European Time (CET), which is UTC+1.
   const timeZone = "Europe/Amsterdam";

   const [year, month, day] = date.split('-').map(Number);
   const [hour, minute] = time.split(':').map(Number);

   // Convert local time to UTC (Amsterdam is UTC+1 in December)
   const utcHour = hour - 1;
   const startUtc = `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}T${utcHour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}:00Z`;
   const endMinute = minute + duration_minutes;
   const endHour = hour + Math.floor(endMinute / 60);
   const endMin = endMinute % 60;
   const utcEndHour = endHour - 1;
   const endUtc = `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}T${utcEndHour.toString().padStart(2, '0')}:${endMin.toString().padStart(2, '0')}:00Z`;

   // Get the primary calendar ID
   const calendarList = await calendar.calendarList.list();
   const primaryCalendar = calendarList.data.items.find(item => item.primary);
   if (!primaryCalendar) {
     return "No primary calendar found.";
   }
   const calendarId = primaryCalendar.id;

   try {
     const requestBody = {
       timeMin: startUtc,
       timeMax: endUtc,
       timeZone: timeZone,
       items: [{ id: calendarId }],
     };
     console.log("Freebusy request:", JSON.stringify(requestBody, null, 2));
     const res = await calendar.freebusy.query({
       requestBody,
     });
     console.log("Freebusy response:", JSON.stringify(res.data, null, 2));

     if (res.data.calendars[calendarId] && res.data.calendars[calendarId].busy.length > 0) {
       return `The time slot from ${date} ${time} (Europe/Amsterdam) for ${duration_minutes} minutes is NOT available.`;
     } else {
       return `The time slot from ${date} ${time} (Europe/Amsterdam) for ${duration_minutes} minutes is available.`;
     }
   } catch (error) {
     console.error("Error checking calendar availability:", error);
     return `Error checking calendar availability: ${error.message}`;
   }
 }

/**
 * Books an appointment on the Google Calendar.
 * @param {string} client_name
 * @param {string} client_email
 * @param {string} start_time ISO 8601 format
 * @param {number} duration_minutes
 * @param {string} purpose
 * @returns {Promise<string>} A confirmation message.
 */
async function bookAppointment(client_name, client_email, date, time, duration_minutes, purpose) {
   const oAuth2Client = await getAuthorizedClient();
   if (!oAuth2Client) {
     return "Google Calendar is not authorized. Please authorize the application first.";
   }
   const calendar = google.calendar({ version: "v3", auth: oAuth2Client });

   // Assume input date and time are for Europe/Amsterdam timezone.
   // For December 2025, Europe/Amsterdam uses Central European Time (CET), which is UTC+1.
   const timeZone = "Europe/Amsterdam";

   const [year, month, day] = date.split('-').map(Number);
   const [hour, minute] = time.split(':').map(Number);

   // Convert local time to UTC (Amsterdam is UTC+1 in December)
   const utcHour = hour - 1;
   const startUtc = `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}T${utcHour.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}:00Z`;
   const endMinute = minute + duration_minutes;
   const endHour = hour + Math.floor(endMinute / 60);
   const endMin = endMinute % 60;
   const utcEndHour = endHour - 1;
   const endUtc = `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}T${utcEndHour.toString().padStart(2, '0')}:${endMin.toString().padStart(2, '0')}:00Z`;

   // Get the primary calendar ID
   const calendarList = await calendar.calendarList.list();
   const primaryCalendar = calendarList.data.items.find(item => item.primary);
   if (!primaryCalendar) {
     return "No primary calendar found.";
   }
   const calendarId = primaryCalendar.id;

   const event = {
     summary: purpose,
     description: `Appointment with ${client_name}.`,
     start: {
       dateTime: startUtc,
       timeZone: timeZone,
     },
     end: {
       dateTime: endUtc,
       timeZone: timeZone,
     },
     attendees: [{ email: client_email }],
   };

   try {
     const res = await calendar.events.insert({
       calendarId: calendarId,
       resource: event,
     });
     return `Appointment successfully booked for ${client_name} from ${date} ${time} (Europe/Amsterdam) for ${duration_minutes} minutes. Event URL: ${res.data.htmlLink}`;
   } catch (error) {
     console.error("Error booking appointment:", error);
     return `Error booking appointment: ${error.message}`;
   }
 }

module.exports = {
  getAuthorizationUrl,
  getAccessToken,
  checkAvailability,
  bookAppointment,
};
