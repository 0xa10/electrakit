import * as hap from 'hap-nodejs'
import qrcode from 'qrcode-terminal'

import { ElectraClient } from './client.mjs'
import logger from './logger.mjs'

/// application environment variables
const TOKEN = process.env.TOKEN
const IMEI = process.env.IMEI
const DEVICE_ID = process.env.DEVICE_ID
const ACCESSORY_NAME = process.env.ACCESSORY_NAME ?? 'Gree Air Conditioner'

async function main() {
  /// setup Gree client

    console.log("glllooo")
  if (TOKEN === undefined) {
    logger.fatal('please set the TOKEN environment variable.')
    process.exit()
  }

  if (IMEI === undefined) {
    logger.fatal('please set the IMEI environment variable.')
    process.exit()
  }

  if (DEVICE_ID === undefined) {
    logger.fatal('please set the DEVICE_ID environment variable')
    process.exit()
  }

  let device_id = Number(DEVICE_ID)
      if (Number.isNaN(device_id)) {
          logger.fatal('please set the DEVICE_ID environment variable to a number')
              process.exit()
      }

  const client = new ElectraClient({token: TOKEN, imei: IMEI})
  const ac = await client.selectDevice(device_id)

    logger.info('new connection to target: ' + device_id)
    /// setup accessory
    const accessory = new hap.Accessory(
      'Electra AC',
      hap.uuid.generate('hap.electra.ac' + device_id),
    )
    // TODO - update fw version and model to correct values
    accessory
      .getService(hap.Service.AccessoryInformation)
      .setCharacteristic(hap.Characteristic.Manufacturer, ac.deviceInformation.providerName ?? "manufacturer unknown")
      .setCharacteristic(hap.Characteristic.Model, ac.deviceInformation.model ?? "model unknown")
      .setCharacteristic(hap.Characteristic.Name, ac.deviceInformation.name ?? "name unknown")
      .setCharacteristic(hap.Characteristic.SerialNumber, ac.deviceInformation.sn ?? "sn unknown")
      .setCharacteristic(hap.Characteristic.FirmwareRevision,  ac.deviceInformation.fmVersion ?? "fw unknown")

    const heaterCoolerService = new hap.Service.HeaterCooler('AC')
    const fanService = new hap.Service.Fan('Fan')

    const activeCharacteristic = heaterCoolerService.getCharacteristic(hap.Characteristic.Active)
    const currentStateCharacteristic = heaterCoolerService.getCharacteristic(
      hap.Characteristic.CurrentHeaterCoolerState,
    )
    const targetStateCharacteristic = heaterCoolerService.getCharacteristic(
      hap.Characteristic.TargetHeaterCoolerState,
    )
    const currentTemperatureCharacteristic = heaterCoolerService.getCharacteristic(
      hap.Characteristic.CurrentTemperature,
    )
    const coolingThresholdTemperatureCharacteristic = heaterCoolerService.getCharacteristic(
      hap.Characteristic.CoolingThresholdTemperature,
    )

    const fanSpeedCharateristic = fanService.getCharacteristic(hap.Characteristic.RotationSpeed)
    const fanActiveCharacteristic = fanService.getCharacteristic(hap.Characteristic.Active)

    /// TODO
    //const displayUnitCharacteristic = heaterCoolerService.getCharacteristic(hap.Characteristic.TemperatureDisplayUnits);
    //const nameCharacteristic = heaterCoolerService.setCharacteristic(hap.Characteristic.Name, ACCESSORY_NAME);

    /// these require a bit more translation from Homekit terminology to ones more compatible with the AC interface
    //const swingModeCharacteristic = heaterCoolerService.getCharacteristic(hap.Characteristic.SwingMode);
    //const heatingThresholdTemperatureCharacteristic = heaterCoolerService.getCharacteristic(
    //  hap.Characteristic.HeatingThresholdTemperature,
    //)

    /// ac active - on/off
    activeCharacteristic
      .onGet(async () => {
        const power = await ac.isOn()
        logger.trace(`activeState.get() = ${power}`)
        if (!power) {
          return 0 // Inactive
        }
        return 1 // Active
      })
      .onSet(async (value) => {
        logger.trace(`activeState.set(${value})`)
        switch (value) {
          case 0: // Inactive
            ac.turnOff()
            break
          case 1: // Active
            ac.turnOn()
            break
          default:
            logger.error('got unexpected value: ' + value)
            break
        }
      })

    /// fan active - on/off
    fanActiveCharacteristic.onGet(async () => {
      const power = await ac.isOn()
      logger.trace(`fanActive.get() = ${power}`)
      if (!power) {
        return 0 // Inactive
      }
      return 1 // Active
    })

    /// current state - heating/cooling + on/off
    currentStateCharacteristic.onGet(async () => {
      const power = await ac.isOn()
      const mode = await ac.getMode()

      logger.trace(`currentState.get() = ${power}, ${mode}`)
      if (!power) {
        return 0 // Inactive
      }

      switch (mode) {
        case 'COOL':
          return 3 // Cooling
          break
        case 'HEAT':
          return 2 // Heating
          break
        default:
          logger.warn('unsupported/idle mode ' + mode)
          return 1 // Idle
      }
    })

    /// target state - heating/cooling
    targetStateCharacteristic
      .onGet(async () => {
        const power = await ac.isOn()
        const mode = await ac.getMode()

        logger.trace(`targetState.get() = ${power}, ${mode}`)
        switch (mode) {
          case 'COOL':
            return 2 // Cooling
            break
          case 'HEAT':
            return 1 // Heating
            break
          case 'AUTO':
            return 0 // Auto
            break
          default:
            logger.warn('unknown target state mode reported: ' + mode)
            return 0 // Auto
        }
      })
      .onSet(async (value) => {
        logger.trace(`targetState.set(${value})`)
        switch (value) {
          case 0: // Auto
            ac.setMode('AUTO')
            break
          case 1: // Heat
            ac.setMode('HEAT')
            break
          case 2: // Cool
            ac.setMode('COOL')
            break
          default:
            logger.warn('unknown target state mode received: ' + value)
            return 0 // Auto
        }
      })

    /// rotation speed
    fanSpeedCharateristic
      .setProps({
        minValue: 0,
        maxValue: 3,
        minStep: 1,
      })
      .onGet(async () => {
        const fanSpeed = await ac.getFanSpeed()

        logger.trace(`fanSpeed.get() = ${fanSpeed}`)
        switch (fanSpeed) {
          case 'AUTO':
            return 0 // Auto
            break
          case 'LOW':
            return 1 // Low
            break
          case 'MED':
            return 2 // Medium
            break
          case 'HIGH':
            return 3 // High
            break
          default:
            logger.warn('unknown fan speed: ' + fanSpeed)
            return 0 // Auto
        }
      })
      .onSet(async (value) => {
        logger.trace(`fanSpeed.set(${value})`)
        let fanSpeed
        switch (value) {
          case 1: // low
            ac.setFanSpeed('LOW')
            break
          case 2: // medium
            ac.setFanSpeed('MED')
            break
          case 3: // high
            ac.setFanSpeed('HIGH')
            break
          case 0:
          default:
            ac.setFanSpeed('AUTO')
            logger.warn('unexpected fanSpeed value, setting to auto.')
        }
      })

    /// current temperature
    currentTemperatureCharacteristic.onGet(async () => {
      const currentTemperature = await ac.getCurrentTemperature()
      logger.trace(`currentTemperature.get() = ${currentTemperature}`)

      return currentTemperature
    })

    /// cooling target - set temperature
    coolingThresholdTemperatureCharacteristic
      .setProps({
        minValue: 16,
        maxValue: 30,
        minStep: 1,
      })
      .onGet(async () => {
        const temperature = await ac.getTargetTemperature()

        logger.trace(`coolingThresholdTemperature.get() = ${temperature}`)
        return temperature
      })
      .onSet(async (value) => {
        logger.trace(`coolingThresholdTemperature.set(${value})`)
        ac.setTargetTemperature(value)
      })

    /// heating target - set temperature
    //heatingThresholdTemperatureCharacteristic
    //  .onGet(() => {
    //    const temperature = unitProperties.temperature

    //    logger.debug("Queried heating threshold temperature: " + temperature)
    //    return temperature
    //  })
    //  .onSet(value => {
    //    logger.debug("Setting heating threshold temperature: " + value)
    //    client.setProperty("temperature", value)
    //  })

    /// bring up service
    accessory.addService(heaterCoolerService)
    accessory.addService(fanService)

    const fake_mac = parseInt(ac.deviceInformation.mac, 16) + 0x133e // We change the mac up slightly for the HAP username
    const formatted_mac = fake_mac
      .toString(16)
      .padStart(12, '0')
      .match(/../g)
      .reverse()
      .slice(0, 6)
      .reverse()
      .join(':') // https://stackoverflow.com/questions/17933471/convert-integer-mac-address-to-string-in-javascript
    const pin_code = fake_mac % 99999999 // this is not intended to be secret in this context
    const formatted_pin_code = [
      pin_code.toString().slice(0, 3),
      pin_code.toString().slice(3, 5),
      pin_code.toString().slice(5, 8),
    ].join('-')

    const setupID = hap.Accessory._generateSetupID()

    /// and publish
    accessory.publish({
      username: formatted_mac,
      pincode: formatted_pin_code,
      setupID: setupID,
      port: 47000 + (fake_mac % 6000), // once again - relate to mac in a close-enough to unique way
      category: hap.Categories.HeaterCooler,
    })

    logger.info('finished accessory setup, running, press Ctrl+C to exit...')
    process.on('SIGINT', function () {
      logger.fatal('Caught interrupt signal')
      process.exit()
    })

    /// print homekit qr-code to screen
    qrcode.generate(makeQrCodeUri(pin_code, setupID))
}

function makeQrCodeUri(pin_code, setupID) {
  let payload = 0
  const flag = 2 // IP
  const version = 0
  const categoryId = hap.Categories.HeaterCooler
  const reserved = 0

  payload = payload | (version & 0x7)

  payload = payload << 4
  payload = payload | (reserved & 0xf)

  payload = payload << 8
  payload = payload | (categoryId & 0xff)

  payload = payload << 4
  payload = payload | (flag & 0xf)

  payload = payload << 27
  payload = payload | (pin_code & 0x7fffffff)

  const payloadBase36 = payload.toString(36).toUpperCase().padStart(9, '0')

  return `X-HM://${payloadBase36}${setupID}`
}


await main()
