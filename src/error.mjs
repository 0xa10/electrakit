class GetDevicesError extends Error {
  constructor(message) {
    super(message)
    this.name = 'GetDevicesError'
  }
}

class GetLastTelemetryError extends Error {
  constructor(message) {
    super(message)
    this.name = 'GetLastTelemetryError'
  }
}

class DeviceError extends Error {
  constructor(message) {
    super(message)
    this.name = 'DeviceError'
  }
}

class SetOperError extends Error {
  constructor(message) {
    super(message)
    this.name = 'SetOperError'
  }
}

export { GetDevicesError, GetLastTelemetryError, DeviceError, SetOperError }
