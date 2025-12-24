const { bookAppointment } = require('../utils/google_calendar_helper');

module.exports = {
  name: "book_appointment",
  description: "Books an appointment for a client in the calendar.",
  input_schema: {
    type: "object",
    properties: {
      client_name: {
        type: "string",
        description: "The name of the client booking the appointment.",
      },
      client_email: {
        type: "string",
        description: "The email address of the client booking the appointment.",
      },
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
      purpose: {
        type: "string",
        description: "The purpose or subject of the appointment.",
      },
    },
    required: ["client_name", "client_email", "date", "time", "duration_minutes", "purpose"],
  },
  handler: async (sessionUuid, { client_name, client_email, date, time, duration_minutes, purpose }) => {
    console.log(`Booking appointment for ${client_name} (${client_email}) on ${date} at ${time} for ${duration_minutes} minutes for purpose: ${purpose}, session: ${sessionUuid}.`);
    return await bookAppointment(client_name, client_email, date, time, duration_minutes, purpose);
  },
};
