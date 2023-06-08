import fs from 'fs/promises';
import axios from 'axios';


const BASE_URL = "https://app.ecpiot.co.il/";

class GetDevicesError extends Error {
    constructor(message) {
        super(message);
        this.name = "GetDevicesError";
    }
}

class GetLastTelemetryError extends Error {
    constructor(message) {
        super(message);
        this.name = "GetLastTelemetryError";
    }
}

class DeviceError extends Error {
    constructor(message) {
        super(message);
        this.name = "DeviceError";
    }
}

class SetOperError extends Error {
    constructor(message) {
        super(message);
        this.name = "SetOperError";
    }
}

class ElectraClient {
	constructor(token, imei) {
        this.token = token;
        this.imei = imei;

        this.api = axios.create({
            baseURL: BASE_URL,
            headers: {'Content-Type': 'application/json', 'User-Agent': "Electra Client"},
        });

        this.sid = null;
        this.devices = null;
    }

    async getDevices() { 
        const payload = {
            pvdid: 1,
            id: 1000,
            cmd: 'GET_DEVICES',        
            sid: this.sid ?? await this.renewSid()
        }
        let res = await this.api.post("mobile/mobilecommand", payload)

        if (res.data.status !== 0) {
            console.error(res);
            throw new GetDevicesError("Failed to get devices");
        }

        let devices = res.data.data?.devices;
        if (devices === undefined) {
            throw new GetDevicesError("Unexpected response from server");
        }
        this.devices = devices;
        return this.devices;
    }

    async getLastTelemetry(deviceId) {
        const payload = {
            pvdid: 1,
            id: 1000,
            cmd: 'GET_LAST_TELEMETRY',
            data: {
                commandName: "OPER,DIAG_L2",
                id: deviceId,
            },
            sid: this.sid ?? await this.renewSid()
        }
        let res = await this.api.post("mobile/mobilecommand", payload)

        if (res.data.status !== 0) {
            throw new GetLastTelemetryError("Failed to get devices");
        }

        let oper = res.data.data?.commandJson?.OPER;
        if (oper === undefined) {
            throw new GetLastTelemetryError("Unexpected response from server when parsing OPER object");
        }

        let diag_l2 = res.data.data?.commandJson?.DIAG_L2;
        if (diag_l2 === undefined) {
            throw new GetLastTelemetryError("Unexpected response from server when parsing DIAG_L2 object");
        }
        try {
            let oper_parsed = JSON.parse(oper); 
            let diag_l2_parsed = JSON.parse(diag_l2);
            return {OPER: oper_parsed.OPER, DIAG_L2: diag_l2_parsed.DIAG_L2};
        } catch (e) {
            console.error(e);
            throw new GetLastTelemetryError("Failed to response");
        }   
    }

    async renewSid() {
        const payload = {
            pvdid: 1,
            id: 99,
            cmd: 'VALIDATE_TOKEN',
            data : {
                imei: this.imei,
                token: this.token,
                os: 'ios',
                osver: "16.5",
            }
        };

        let res = await this.api.post("mobile/mobilecommand", payload)
        console.log(res.data);
        console.log(res);
        
        const newSid = res.data.data?.sid; 
        if (newSid === undefined) {
            throw new Error("Failed to renew sid");
        }

        this.sid = newSid;
        return this.sid;
    }

    async selectDevice(deviceId) {
        let devices = this.devices ?? await this.getDevices();
        let device = devices.find((device) => device.id === deviceId);

        if (device === undefined) {
            throw new DeviceError("Device not found");
        }
        console.log(device)

        return new ElectraAC(this, deviceId);
    }
}


class ElectraAC {
    constructor(client, deviceId, stale_duration = 1000) {
        this.client = client;
        this.deviceId = deviceId;

        this.state = null;
        this.expiration = null;
        this.stale_duration = stale_duration;
    }

    async getState() {
        return this.state ?? await this.update();
    }


    invalidateState() {
        // Call this after initiating a state change
        this.state = null;
        clearTimeout(this.staleTimer);
    }
    

    async update() {
        console.log("Updating state");
        this.state = await this.client.getLastTelemetry(this.deviceId);
        this.staleTimer = setTimeout(() => {
            this.state = null;
        }, this.stale_duration);
        return this.state;
    }

    async sendCommand(newState) {
        const payload = {
            pvdid: 1,
            id: 1000,
            cmd: 'SEND_COMMAND',
            sid: this.client.sid ?? await this.client.renewSid(),
            data: {
                id: this.deviceId,
                commandJson: JSON.stringify({OPER: newState.OPER}), // Send only OPER
            }
        }
        let res = await this.client.api.post("mobile/mobilecommand", payload)
        if (res.data.status !== 0) {
            console.error(res);
            throw new SetOperError("Send Command failed");
        }
    }

    // Status
    async isOn() {
        return await this.getMode() !== "STBY";
    }

    async getMode() {
        let state = await this.getState();
         
        return state.OPER?.AC_MODE;
    }

    async setMode(mode) {
        console.log("Setting mode to " + mode);
        if (mode !== "COOL" && mode !== "HEAT" && mode !== "STBY") {
            /// TODO - support other modes? DRY, FAN, AUTO
            throw new SetOperError(`Tried to set invalid AC mode: ${mode}`);
        }

        let state = await this.getState();

        if (state.OPER?.AC_MODE === mode) {
            console.warn("AC is already on and in chosen mode, proceeding anyway"); 
        }

        let newState = state;
        newState.OPER.AC_MODE = mode;
    
        await this.sendCommand(newState);
    }

    async turnOff() {
        await this.setMode("STBY");
    }
    
    // Target temperature
    async setTargetTemperature(temp) {
        console.log("Setting target temperature to " + temp);
        if (temp < 16 || temp > 30) {
            throw new SetOperError(`Tried to set invalid temperature: ${temp}`);
        }

        let state = await this.getState();
        if (state.OPER?.SPT === temp) {
            console.warn("AC is already on and at chosen temperature, proceeding anyway"); 
        }

        let newState = state;
        newState.OPER.SPT = temp;
        
        await this.sendCommand(newState);
    }

    async getTargetTemperature() {
        let state = await this.getState();
        return state.OPER?.SPT;
    }

    // Current temperature
    async getCurrentTemperature() {
        let state = await this.getState();
        return state.DIAG_L2?.I_CALC_AT; // Use this over I_ICT or I_RAT?
    }
    
    // Fan speed
    async getFanSpeed() {
        let state = await this.getState();
        return state.OPER?.FANSPD;
    }

    async setFanSpeed(speed) {
        console.log("Setting fan speed to " + speed);
        if (speed !== "AUTO" && speed !== "LOW" && speed !== "MED" && speed !== "HIGH") {
            throw new SetOperError(`Tried to set invalid fan speed: ${speed}`);
        }

        let state = await this.getState();
        if (state.OPER?.FANSPD === speed) {
            console.warn("AC is already on and in chosen fan speed, proceeding anyway"); 
        }

        let newState = state;
        newState.OPER.FANSPD = mode;
    
        await this.sendCommand(newState);
    }
}

async function main() {
    // read token from file
    let data = await fs.readFile('token');    
    data = JSON.parse(data);
    let imei = '2b95000087654322';
    let sid = data.data.sid;
    let token = data.data.token;
    let client = new ElectraClient(token, imei);
    client.sid = sid;
    let devices = await client.getDevices();
    for (let device of devices) {
        console.log("[*] Device: " + device.name + " ID: :" + device.id);
    }
    let ac = await client.selectDevice(171451)

    function sleep(time) {
        return new Promise(resolve => setTimeout(resolve, time));
    }

    for (let i = 0; i < 0; i++) {
        await sleep(1000);
        console.log(i);
        console.log(await ac.getState())
    }

    console.log("Current temp is: " + await ac.getCurrentTemperature());
    console.log("Target temp is: " + await ac.getTargetTemperature());
    if (await ac.isOn()) {
        console.log("AC is on, turning off");
        await ac.turnOff();
    }
}

// only run if this file is the main file
await main()
