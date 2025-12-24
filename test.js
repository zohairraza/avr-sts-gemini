require("dotenv").config({ path: "../../.env" });

const { checkAvailability } = require("./utils/google_calendar_helper");

checkAvailability("2025-12-24", "09:00", 30).then(result => console.log("Result:", result)).catch(err => console.error("Error:", err));