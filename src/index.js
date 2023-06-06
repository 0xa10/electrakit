const axios = require('axios');


const IMEI_PREFIX = "2b950000";
const BASE_URL = "https://app.ecpiot.co.il/mobile/mobilecommand";

class ElectraClient {
    static randomIMEI() {
        return IMEI_PREFIX + Math.floor(Math.random() * 100000000);
    }

    static async login(phone_number) {
        const imei = ElectraClient.randomIMEI();
        const data = {
           pvdid: 1,
           id: 99,
           cmd: 'SEND_OTP',
           data: {
               imei: imei,
               phone: phone_number,
           },
        };

        const response = await axios.post(BASE_URL, {
            imei: imei,
            phone: phone_number
        });
    }
    
    constructor(token, imei) {
    }
}
