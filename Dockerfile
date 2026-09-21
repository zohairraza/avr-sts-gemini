FROM node:20-alpine As development

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm ci --omit=dev && npm cache clean --force

###################
# BUILD FOR PRODUCTION
###################

FROM node:20-alpine As build

WORKDIR /usr/src/app

COPY --chown=node:node --from=development /usr/src/app/node_modules ./node_modules

# Copy all tool directories
COPY --chown=node:node avr_tools/ ./avr_tools/
# tools/ and utils/ are provided by avr-gemini-tools via volume mounts
RUN mkdir -p tools utils && chown node:node tools utils

# Copy main application files
COPY --chown=node:node loadTools.js .
COPY --chown=node:node index.js .

# Create and set permissions for the logs directory
RUN mkdir -p logs && chown -R node:node logs

# Disable audio saving by default for better performance
ENV AUDIO_SAVE_ENABLED=false

# Default thinking configuration
ENV GEMINI_THINKING_LEVEL=MINIMAL
ENV GEMINI_THINKING_BUDGET=0

USER node

CMD [ "node", "index.js" ]