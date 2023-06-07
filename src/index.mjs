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

        let telemetry = res.data.data?.commandJson?.OPER;
        if (telemetry === undefined) {
            throw new GetLastTelemetryError("Unexpected response from server");
        }
        try {
            return JSON.parse(telemetry);
        } catch (e) {
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

    for (let i = 0; i < 10; i++) {
        await sleep(1000);
        console.log(i);
        console.log(await ac.getState())
    }
}

// only run if this file is the main file
await main()
