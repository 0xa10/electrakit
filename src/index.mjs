import fs from 'fs/promises'
import axios from 'axios'
import { Mutex } from 'async-mutex'
import { EventEmitter } from 'events'

const BASE_URL = 'https://app.ecpiot.co.il/'

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

class ElectraClient {
  constructor(token, imei) {
    this.token = token
    this.imei = imei

    this.api = axios.create({
      baseURL: BASE_URL,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Electra Client' },
    })

    this.sid = null
    this.devices = null

    this.retry = true
  }

  async getDevices() {
    const payload = {
      pvdid: 1,
      id: 1000,
      cmd: 'GET_DEVICES',
      sid: this.sid ?? (await this.renewSid()),
    }
    let res = await this.api.post('mobile/mobilecommand', payload)

    if (this.retry && res.data.status !== 0) {
      // If we failed to get devices, renew sid and retry
      payload.sid = await this.renewSid()
      res = await this.api.post('mobile/mobilecommand', payload)
    }

    if (res.data.status !== 0) {
      console.error(res)
      throw new GetDevicesError('Failed to get devices')
    }

    let devices = res.data.data?.devices
    if (devices === undefined) {
      throw new GetDevicesError('Unexpected response from server')
    }
    this.devices = devices
    return this.devices
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
      sid: this.sid ?? (await this.renewSid()),
    }
    let res = await this.api.post('mobile/mobilecommand', payload)

    if (this.retry && res.data.status !== 0) {
      // If we failed to get devices, renew sid and retry
      payload.sid = await this.renewSid()
      res = await this.api.post('mobile/mobilecommand', payload)
    }

    if (res.data.status !== 0) {
      throw new GetLastTelemetryError('Failed to get devices')
    }

    let oper = res.data.data?.commandJson?.OPER
    if (oper === undefined) {
      throw new GetLastTelemetryError('Unexpected response from server when parsing OPER object')
    }

    let diag_l2 = res.data.data?.commandJson?.DIAG_L2
    if (diag_l2 === undefined) {
      throw new GetLastTelemetryError('Unexpected response from server when parsing DIAG_L2 object')
    }
    try {
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
        imei: this.imei,
        token: this.token,
        os: 'ios',
        osver: '16.5',
      },
    }

    let res = await this.api.post('mobile/mobilecommand', payload)

    const newSid = res.data.data?.sid
    if (newSid === undefined) {
      throw new Error('Failed to renew sid')
    }

    this.sid = newSid
    return this.sid
  }

  async selectDevice(deviceId) {
    let devices = this.devices ?? (await this.getDevices())
    let device = devices.find(device => device.id === deviceId)

    if (device === undefined) {
      throw new DeviceError('Device not found')
    }
    console.log(device)

    return new ElectraAC(this, deviceId)
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

class Waker {
  constructor() {
    // TODO - replace with eventemitter design
    this._event_emitter = new EventEmitter()
  }

  async wake() {
    this._event_emitter.emit('wake')
  }

  async wait() {
    await new Promise(resolve => {
      this._event_emitter.once('wake', resolve)
    })
  }
}

class ElectraAC {
  constructor(client, deviceId, stale_duration = 1000, syncInterval = 5000) {
    this.client = client
    this.deviceId = deviceId

    this.state = null
    this.expiration = null
    this.stale_duration = stale_duration

    this.syncInterval = syncInterval

    this.pending_changes = {}
    this.pending_changes_mutex = new Mutex() // This is probably not necessary in JS, but easier than finding out
    this.pending_changes_waker = new Waker()

    // Start background task for applying changes
    process.nextTick(() => {
      this.syncTask()
    })
  }

  // Get the current state, or update it if its stale. Force invalidate if requested
  async getState(invalidate = false) {
    if (invalidate) {
      return await this.updateState()
    } else {
      return this.state ?? (await this.updateState())
    }
  }

  // Set the local state, and start a timer to invalidate it
  setState(newState) {
    this.state = newState
    clearTimeout(this.staleTimer)
    this.staleTimer = setTimeout(() => {
      this.state = null
      console.trace('State expired')
    }, this.stale_duration)
  }

  // Read a new state from the server and update the local state
  async updateState() {
    let upstreamState = await this.client.getLastTelemetry(this.deviceId)
    console.log('Updating state')
    console.log(upstreamState)
    this.setState(upstreamState)
    return this.state
  }

  // The sync task loops on any queued changes, and applies them to the device
  // When done, it goes to sleep until awoken by queueChanges
  async syncTask() {
    while (true) {
      // Ideally - condition on some member so we can "cancel" this loop
      await this.pending_changes_waker.wait() // First wait for wakeup
      console.trace('syncTask woke up')
      while (true) {
        // We break out when we have no pending changes
        let newState = await this.getState(true) // Get a copy of the uncached state
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
    console.log('updating pending')
    this.pending_changes = { ...this.pending_changes, ...oper_delta }
    release()
    console.log('calling wake')
    await this.pending_changes_waker.wake()
  }

  // Send an updated OPER state
  async sendCommand(newState) {
    const payload = {
      pvdid: 1,
      id: 1000,
      cmd: 'SEND_COMMAND',
      sid: this.client.sid ?? (await this.client.renewSid()),
      data: {
        id: this.deviceId,
        commandJson: JSON.stringify({ OPER: newState.OPER }), // Send only OPER
      },
    }
    let res = await this.client.api.post('mobile/mobilecommand', payload)

    if (this.retry && res.data.status !== 0) {
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
    if (mode !== 'COOL' && mode !== 'HEAT' && mode !== 'STBY' && mode !== 'DRY') {
      /// TODO - support other modes? DRY, FAN, AUTO
      throw new SetOperError(`Tried to set invalid AC mode: ${mode}`)
    }

    await this.queueChange({ AC_MODE: mode })
  }

  async turnOff() {
    await this.setMode('STBY')
  }

  async setTargetTemperature(temp) {
    console.log('Setting target temperature to ' + temp)
    if (temp < 16 || temp > 30) {
      throw new SetOperError(`Tried to set invalid temperature: ${temp}`)
    }

    await this.queueChange({ SPT: temp.toString() })
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

    await this.queueChange({ FANSPD: speed })
  }
}

async function main() {
  // read token from file
  let data = await fs.readFile('token')
  data = JSON.parse(data)
  let imei = '2b95000087654322'
  let sid = data.data.sid
  let token = data.data.token
  let client = new ElectraClient(token, imei)
  client.sid = sid
  let devices = await client.getDevices()
  for (let device of devices) {
    console.log('[*] Device: ' + device.name + ' ID: :' + device.id)
  }
  let ac = await client.selectDevice(171451)

  console.log('Current temp is: ' + (await ac.getCurrentTemperature()))
  console.log('Target temp is: ' + (await ac.getTargetTemperature()))
  console.log('Fan speed is: ' + (await ac.getFanSpeed()))
  await sleep(30000)
  console.log('************** AC is off, turning on and setting to med fan, 21 degrees')
  await ac.setTargetTemperature(21)
  await sleep(6000)
  await ac.setMode('COOL')
  await ac.setFanSpeed('MED')
  await sleep(30000)
  console.log('************** AC is off, turning on and setting to dry auto fan, 23 degrees')
  await ac.setTargetTemperature(23)
  await ac.setFanSpeed('AUTO')
  await sleep(30000)
  console.log('************** AC is on, turning off')
  await ac.turnOff()
}

await main()
