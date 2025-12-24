const { checkAvailability } = require('../utils/google_calendar_helper');

module.exports = {
  name: "check_availability",
  description: "Checks the availability for a specific time and duration for an appointment.",
  input_schema: {
    type: "object",
    properties: {
      date: {
        type: "string",
        description: "The date of the appointment in YYYY-MM-DD format.",
      },
      time: {
        type: "string",
        description: "The start time of the appointment in HH:MM format (UTC).",
      },
      duration_minutes: {
        type: "number",
        description: "The duration of the appointment in minutes.",
      },
    },
    required: ["date", "time", "duration_minutes"],
  },
  handler: async (sessionUuid, { date, time, duration_minutes }) => {
    console.log(`Checking availability for ${date} at ${time} for ${duration_minutes} minutes for session ${sessionUuid}.`);
    return await checkAvailability(date, time, duration_minutes);
  },
};
