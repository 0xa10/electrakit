import fs from 'fs/promises'
import axios from 'axios'
import { Mutex } from 'async-mutex'
import { EventEmitter } from 'events'

import logger from './logger.mjs'
import { DeviceError, GetDevicesError, GetLastTelemetryError } from './error.mjs'

const BASE_URL = 'https://app.ecpiot.co.il/'

class ElectraClient {
  constructor(options) {
    this._imei = options.imei
    this._token = options.token
    this._retry = options.retry ?? true

    this.api = axios.create({
      baseURL: BASE_URL,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Electra Client' },
    })

    this._sid = null
  }

  async getDevices() {
    const payload = {
      pvdid: 1,
      id: 1000,
      cmd: 'GET_DEVICES',
      sid: this._sid ?? (await this.renewSid()),
    }
    let res = await this.api.post('mobile/mobilecommand', payload)

    if (this._retry && res.data.status !== 0) {
      logger.error('failed to get devices, renewing SID and retrying')
      // If we failed to get devices, renew sid and retry
      payload.sid = await this.renewSid()
      res = await this.api.post('mobile/mobilecommand', payload)
    }

    logger.debug(`GET_DEVICES response: ${JSON.stringify(res.data)}`)

    if (res.data.status !== 0) {
      throw new GetDevicesError('GET_DEVICES failed')
    }

    let devices = res.data.data?.devices
    if (devices === undefined) {
      throw new GetDevicesError('unexpected response from server')
    }

    return devices
  }

  async getLastTelemetry(deviceId) {
    const payload = {
      pvdid: 1,
      id: 1000,
      cmd: 'GET_LAST_TELEMETRY',
      data: {
        commandName: 'OPER,DIAG_L2',
        id: deviceId,
      },
      sid: this._sid ?? (await this.renewSid()),
    }
    let res = await this.api.post('mobile/mobilecommand', payload)

    if (this._retry && res.data.status !== 0) {
      logger.error('failed to get devices, renewing SID and retrying')
      // If we failed to get devices, renew sid and retry
      payload.sid = await this.renewSid()
      res = await this.api.post('mobile/mobilecommand', payload)
    }

    logger.debug(`GET_LAST_TELEMETRY response: ${JSON.stringify(res.data)}`)

    if (res.data.status !== 0) {
      throw new GetLastTelemetryError('Failed to get devices')
    }

    let oper = res.data.data?.commandJson?.OPER
    if (oper === undefined) {
      throw new GetLastTelemetryError('unexpected response from server when parsing OPER object')
    }

    let diag_l2 = res.data.data?.commandJson?.DIAG_L2
    if (diag_l2 === undefined) {
      throw new GetLastTelemetryError('unexpected response from server when parsing DIAG_L2 object')
    }

    try {
        // Save the deserialized JSONs in the state variable
      let oper_parsed = JSON.parse(oper)
      let diag_l2_parsed = JSON.parse(diag_l2)
      return { OPER: oper_parsed.OPER, DIAG_L2: diag_l2_parsed.DIAG_L2 }
    } catch (e) {
      console.error(e)
      throw new GetLastTelemetryError('Failed to response')
    }
  }

  async renewSid() {
    const payload = {
      pvdid: 1,
      id: 99,
      cmd: 'VALIDATE_TOKEN',
      data: {
        imei: this._imei,
        token: this._token,
        os: 'ios',
        osver: '16.5',
      },
    }

    let res = await this.api.post('mobile/mobilecommand', payload)
    logger.debug(`VALIDATE_TOKEN response: ${JSON.stringify(res.data)}`)

    const newSid = res.data.data?.sid
    if (newSid === null) {
      throw new Error('Failed to renew sid')
    }
    
    logger.info("sucessfully renewed sid")
    this._sid = newSid
    return this._sid
  }

  async selectDevice(deviceId) {
    let devices = await this.getDevices()
    let device = devices.find(device => device.id === deviceId)

    if (device === undefined) {
      throw new DeviceError(`device ${deviceId} not found`)
    }

    logger.debug('selected device: ', device)
    return new ElectraAC(this, deviceId, device)
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

class ElectraAC {
  constructor(client, deviceId, deviceInformation, stateLifetime = 5000, syncInterval = 5000) {
    this._client = client
    this.deviceId = deviceId

    this.deviceInformation = deviceInformation

    this.state = null
    this.stateExpiration = null
    this.stateLifetime = stateLifetime

    this.syncInterval = syncInterval

    // TODO - perhaps refactor to a different object (change manager)
    this.pending_changes = {}
    this.pending_changes_mutex = new Mutex() // This is probably not necessary in JS, but easier than finding out
    this.pending_changes_event_bus = new EventEmitter()

    this.pending_changes_event_bus.waitFor = async (e) => {
        let args;

        await new Promise(resolve => {
            this.pending_changes_event_bus.once(e, (...a) => {
                resolve()
                args = a 
            })
        })

        return args
    }

    // Start background task for applying changes
    process.nextTick(() => {
      this.syncTask()
    })
  }

  // Get the current state, or update it if its stale. Force invalidate if requested
  async getState() {
    if (this.state === null || this.stateExpiration < Date.now()) {
      console.log("State is stale, updating")
      return await this.updateState()
    }
    return this.state
  }

  // Set the local state, and start a timer to invalidate it
  setState(newState) {
    this.state = newState
    this.stateExpiration = Date.now() + this.stateLifetime
  }

  // Read a new state from the server and update the local state
  async updateState() {
    let upstreamState = await this._client.getLastTelemetry(this.deviceId)
    console.log('Updating state')
    this.setState(upstreamState)
    return this.state
  }

  // The sync task loops on any queued changes, and applies them to the device
  // When done, it goes to sleep until awoken by queueChanges
  async syncTask() {
    while (true) {
      // Ideally - condition on some member so we can "cancel" this loop
      await this.pending_changes_event_bus.waitFor('wake') // First wait for wakeup
      console.trace('syncTask woke up')
      while (true) {
        // We break out when we have no pending changes
        let newState = await this.updateState() // Get a copy of the uncached state
        const release = await this.pending_changes_mutex.acquire()
        try {
          // Check if there are any changes to apply
          const change_count = Object.keys(this.pending_changes).length
          if (change_count === 0) {
            console.warn('syncTask called with no pending changes') // This shouldnt happen is everything is working properly
            break
          }
          console.log(`Pending changes: ${JSON.stringify(this.pending_changes)}`)

          // Clear any keys that have been commited upstream succesfully
          for (const key of Object.keys(this.pending_changes)) {
            if (newState.OPER[key] === this.pending_changes[key]) {
              console.log(`Update confirmed to ${key}`)
              this.pending_changes_event_bus.emit('done', key)
              delete this.pending_changes[key]
            }
          }
          if (Object.keys(this.pending_changes).length === 0) {
            console.log('All changes applied')
            break
          }
          // Apply remaining changes
          console.log(`Applying changes ${JSON.stringify(this.pending_changes)}`)
          newState.OPER = { ...newState.OPER, ...this.pending_changes }
        } finally {
          release()
        }
        console.log('Sending command')
        await this.sendCommand(newState)
        await sleep(this.syncInterval)
      }
    }
  }

  // Queue an incremental change to OPER
  async queueChange(oper_delta) {
    const release = await this.pending_changes_mutex.acquire()
    try {
        this.pending_changes = { ...this.pending_changes, ...oper_delta }
    } finally {
        release()
    }
    await this.pending_changes_event_bus.emit('wake')

    return this.waitForChanges(oper_delta)
}
  
  async waitForChanges(oper_delta) {
    return await Promise.all(Object.keys(oper_delta).map(key => this.waitForChange(key)))

  }

  async waitForChange(key) {
    let resolve;
    let p = new Promise(res => resolve = res)

    let callback = (changed_key) => {
        if (changed_key === key) {
            resolve()
        }
    }

    this.pending_changes_event_bus.on('done', callback)
        
    await p

    this.pending_changes_event_bus.off('done', callback)
  }

  // Send an updated OPER state
  async sendCommand(newState) {
    const payload = {
      pvdid: 1,
      id: 1000,
      cmd: 'SEND_COMMAND',
      sid: this._client._sid ?? (await this._client.renewSid()),
      data: {
        id: this.deviceId,
        commandJson: JSON.stringify({ OPER: newState.OPER }), // Send only OPER
      },
    }
    let res = await this._client.api.post('mobile/mobilecommand', payload)

    if (this._retry && res.data.status !== 0) {
      // If we failed to get devices, renew sid and retry
      payload.sid = await this.renewSid()
      res = await this.api.post('mobile/mobilecommand', payload)
    }

    if (res.data.status !== 0) {
      console.error(res)
      throw new SetOperError('Send Command failed')
    }
  }

  async isOn() {
    return (await this.getMode()) !== 'STBY'
  }

  async getMode() {
    let state = await this.getState()

    return state.OPER?.AC_MODE
  }

  async setMode(mode) {
    console.log('Setting mode to ' + mode)
    if (mode !== 'COOL' && mode !== 'HEAT' && mode !== 'STBY' && mode !== 'DRY' && mode !== 'FAN' && mode !== 'AUTO') {
      /// TODO - support other modes? DRY, FAN, AUTO
      throw new SetOperError(`Tried to set invalid AC mode: ${mode}`)
    }

    const ticket = await this.queueChange({ AC_MODE: mode })
    await ticket
  }

  async turnOff() {
    await this.setMode('STBY')
  }

  async turnOn() {
    await this.setMode('COOL') // TODO - add last mode tracking
  }

  async setTargetTemperature(temp) {
    console.log('Setting target temperature to ' + temp)
    if (temp < 16 || temp > 30) {
      throw new SetOperError(`Tried to set invalid temperature: ${temp}`)
    }

    const ticket = await this.queueChange({ SPT: temp.toString() })
    await ticket
  }

  async getTargetTemperature() {
    let state = await this.getState()
    return state.OPER?.SPT
  }

  // Current temperature
  async getCurrentTemperature() {
    let state = await this.getState()
    return state.DIAG_L2?.I_CALC_AT // Use this over I_ICT or I_RAT?
  }

  // Fan speed
  async getFanSpeed() {
    let state = await this.getState()
    return state.OPER?.FANSPD
  }

  async setFanSpeed(speed) {
    console.log('Setting fan speed to ' + speed)
    if (speed !== 'AUTO' && speed !== 'LOW' && speed !== 'MED' && speed !== 'HIGH') {
      throw new SetOperError(`Tried to set invalid fan speed: ${speed}`)
    }

    const ticket = await this.queueChange({ FANSPD: speed })
    await ticket
  }
}

async function main() {
  // read token from file
  let data = await fs.readFile('token')
  data = JSON.parse(data)
  let imei = '2b95000087654322'
  let sid = data.data.sid
  let token = data.data.token
  let client = new ElectraClient({token: token, imei: imei})
  client._sid = sid
  let devices = await client.getDevices()
  for (let device of devices) {
    console.log('[*] Device: ' + device.name + ' ID: :' + device.id)
  }
  let ac = await client.selectDevice(171451)

  console.log('Current temp is: ' + (await ac.getCurrentTemperature()))
  console.log('Target temp is: ' + (await ac.getTargetTemperature()))
  console.log('Fan speed is: ' + (await ac.getFanSpeed()))
  await sleep(5000)
  console.log('************** AC is off, turning on and setting to med fan, 21 degrees')
  let p1 = ac.setTargetTemperature(21)
  let p2 = ac.setMode('COOL')
  let p3 = ac.setFanSpeed('MED')
  await Promise.all([p1, p2, p3])
  
  await sleep(30000)
  console.log('************** AC is off, turning on and setting to dry auto fan, 23 degrees')
  await ac.setTargetTemperature(23)
  await ac.setFanSpeed('AUTO')
  await sleep(30000)
  console.log('************** AC is on, turning off')
  await ac.turnOff()
}


export { ElectraClient }
