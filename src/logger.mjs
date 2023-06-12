import { createLogger, format, transports } from 'winston'

const logLevels = {
  fatal: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
}

const logger = createLogger({
  levels: logLevels,
  level: process.env.LOG_LEVEL ?? 'error',
  format: format.combine(format.json(), format.timestamp(), format.prettyPrint()),
  transports: [new transports.Console()],
})

export default logger
