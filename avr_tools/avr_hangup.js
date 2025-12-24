require("dotenv").config();

const axios = require("axios");

module.exports = {
  name: "avr_hangup",
  description:
    "Ends the conversation once the maintenance is booked or if no availability is found.",
  input_schema: {
    type: "object",
    properties: {},
    required: [],
  },
  handler: async (uuid, {}) => {
    console.log("Hangup call");
    const url = process.env.AMI_URL || "http://127.0.0.1:6006";
    try {
      const res = await axios.post(`${url}/hangup`, { uuid });
      console.log("Hangup response:", res.data);
      return res.data.message;
    } catch (error) {
      console.error("Full error during hangup:", error); // Log the full error object
      if (error.response) {
        // The request was made and the server responded with a status code
        // that falls out of the range of 2xx
        console.error("Hangup error response data:", error.response.data);
        console.error("Hangup error response status:", error.response.status);
      } else if (error.request) {
        // The request was made but no response was received
        console.error("Hangup error: No response received for request:", error.request);
      } else {
        // Something happened in setting up the request that triggered an Error
        console.error("Hangup error message:", error.message);
      }
      return `Error during hangup: ${error.message}`;
    }
  },
};
