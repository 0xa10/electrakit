# ElectraKit
The application requires authentication using OTP.
To log in:
```bash
IMEI=$(echo 2b950000`shuf -rn "8" -i "0-9"  | tr -d "\n"`)
PHONE_NUMBER=[your phone number]
curl -X POST \
  -H "Content-Type: application/json" \
  -H "User-Agent: Electra Client" \
  -d '{
        "pvdid": 1,
        "id": 99,
        "cmd": "SEND_OTP",
        "data": {
            "imei": "$IMEI",
            "phone": "$PHONE_NUMBER"
        }
    }' \
  https://app.ecpiot.co.il/mobile/mobilecommand
```

Wait for the OTP code to arrive, then:
```bash
OTP_CODE=[code you got]
curl -X POST \
  -H "Content-Type: application/json" \
  -H "User-Agent: Electra Client" \
  -d '{
        "pvdid": 1,
        "id": 99,
        "cmd": "CHECK_OTP",
        "data": {
            "imei": "$IMEI",
            "phone": "$PHONE_NUMBER",
            "code": "$OTP_CODE",
            "os": "ios",
            "osver": "16.5",
        }
    }' \
  https://app.ecpiot.co.il/mobile/mobilecommand
```

And set the token according to the response:
```bash
{
  "id": 99,
  "status": 0,
  "desc": null,
  "data": {
    "token": "[removed---------]", # <--- this is what you need
    "sid": "[removed---------]",
    "res": 0,
    "res_desc": null
  }
}
```

Then, run in Docker as such:

# API research

Most of my research is based on the code in https://github.com/yonatanp/electrasmart and https://github.com/nitaybz/homebridge-electra-smart.

Few things I noticed along the way - pvdid and id are optional in most requests. Not sure what pvdid is but id seems to be just a handle so we can associate reponses with requests.

All requests should be issued the the User-Agent set to `Electra Client`, to base url `https://app.ecpiot.co.il/mobile/mobilecommand`

# IMEI

The IMEI needs to be in the format:

```
2b950000 + [random sequence of 8 digits]
```

# Token

To generate a token, you must authenticate using OTP.
First you send:

```
{
    'pvdid': 1,
        'id': 99,
        'cmd': 'SEND_OTP',
        'data': {
            'imei': [generated imei],
            'phone': [phone number with which the ac is registered]
}
```

When the OTP arrives, you send it back:

```
{
    'pvdid': 1,
    'id': 99,
    'cmd': 'CHECK_OTP',
    'data': {
        'imei': [generated imei],
        'phone': [phone number used]
        'code': [otp code],
        'os': 'android',
        'osver': 'M4B30Z'
}
```

The token will be returned at this point.

# SID

To acquire a session id, you need the imei and token:

```
{
    'pvdid': 1,
    'id': 99,
    'cmd': 'VALIDATE_TOKEN',
    'data': {
        'imei': [imei],
        'token': [token],
        'os': 'android',
        'osver': 'M4B30Z'
    }
```

The SID is valid for 1 hour, and should be cached.

# Listing devices

To list devices, you must have a valid SID

```
{
    'pvdid': 1,
    'id': 99,
    'cmd': 'GET_DEVICES',
    'sid': [sid]
}
```

Each devices has an id, mac address, serial number, device name and type

# Device telemetry

To fetch the current device state, you must have a valid sid

```
{
    'pvdid': 1,
    'id': 99,
    'cmd': 'GET_LAST_TELEMETRY',
    'sid': [sid],
    'data': {
        'id': [device id],
        'commandName': 'OPER' # Also DIAG_L2, HB ?
    }
}
```

The object returned should have all the current AC state characteristics.

# Updating the state

To update the state, send the following

```
{
    'pvdid': 1,
    'id': 99,
    'cmd': 'SEND_COMMAND',
    'sid': [sid],
    'data': {
        'id': [device id],
        'commandJson': {'OPER': [updated state]}
    }
}
```

OPER['AC_STSRC'] must always be set to `WI-FI`

# Request response examples

## SEND_OTP

Request:

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -H "User-Agent: Electra Client" \
  -d '{
        "pvdid": 1,
        "id": 99,
        "cmd": "SEND_OTP",
        "data": {
            "imei": "2b95000087654321",
            "phone": "123"
        }
    }' \
  https://app.ecpiot.co.il/mobile/mobilecommand
```

Response:

```json
{
  "id": 99,
  "status": 0,
  "desc": null,
  "data": {
    "res": 0,
    "res_desc": null
  }
}
```

## CHECK_OTP

Request:

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -H "User-Agent: Electra Client" \
  -d '{
        "pvdid": 1,
        "id": 99,
        "cmd": "CHECK_OTP",
        "data": {
            "imei": "2b95000087654321",
            "phone": "1234",
            "code": "5550",
            "os": "android",
            "osver": "M4B30Z",
        }
    }' \
  https://app.ecpiot.co.il/mobile/mobilecommand
```

Response:

```json
{
  "id": 99,
  "status": 0,
  "desc": null,
  "data": {
    "token": "123",
    "sid": "123",
    "res": 0,
    "res_desc": null
  }
}
```

## VALIDATE_TOKEN

Request:

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -H "User-Agent: Electra Client" \
  -d '{
        "pvdid": 1,
        "id": 99,
        "cmd": "VALIDATE_TOKEN",
        "data": {
            "token": "123",
            "imei": "2b95000087654321",
            "os": "android",
            "osver": "M4B30Z",
        }
    }' \
  https://app.ecpiot.co.il/mobile/mobilecommand
```

Response:

```json
{
  "id": 99,
  "status": 0,
  "desc": null,
  "data": {
    "sid": "123",
    "res": 0,
    "res_desc": null
  }
}
```

## GET_DEVICES

Request:

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -H "User-Agent: Electra Client" \
  -d '{
        "cmd": "GET_DEVICES",
        "sid": "123"
    }' \
  https://app.ecpiot.co.il/mobile/mobilecommand
```

Response:

```json
{
  "id": 99,
  "status": 0,
  "desc": null,
  "data": {
    "devices": [
      {
        "providerName": "Electra",
        "deviceTypeName": "A/C",
        "manufactor": "מיני מרכזי",
        "photoId": null,
        "permissions": 15,
        "isGroupMember": false,
        "mode": null,
        "OwnerUsername": "1234",
        "deviceTypeId": 1,
        "name": "סלון",
        "status": 0,
        "providerid": 1,
        "latitude": null,
        "longitude": null,
        "location": null,
        "sn": "123",
        "mac": "123",
        "model": "K074133343",
        "hwVersion": null,
        "fmVersion": "611V4-C12",
        "userId": 123,
        "manufactorId": 1,
        "iconId": null,
        "hasImage": false,
        "deviceToken": "123",
        "mqttId": "d:alk2da:electra_ac:123",
        "enableEvents": true,
        "isActivated": true,
        "logLevel": null,
        "lastIntervalActivity": null,
        "powerKWH": null,
        "IsDebugMode": false,
        "regdate": "2023-06-04T21:46:07",
        "id": 123
      }
    ],
    "res": 0,
    "res_desc": null
  }
}
```

## GET_LAST_TELEMETRY

Request:

```bash
curl -X POST \
  -H "Content-Type: application/json" \
  -H "User-Agent: Electra Client" \
  -d '{
        "pvdid": 1,
        "id": 99,
        "cmd": "GET_LAST_TELEMETRY",
        "sid": "123",
        "data": {
            "commandName": "OPER,DIAG_L2,HB",
            "id": '123',
        }
    }' \
  https://app.ecpiot.co.il/mobile/mobilecommand
```

Response (just OPER):

```json
{
  "id": 99,
  "status": 0,
  "desc": null,
  "data": {
    "timeDelta": 70,
    "commandJson": {
      "OPER": "{\"OPER\":{\"AC_MODE\":\"STBY\",\"AC_STSRC\":\"WI-FI\",\"SPT\":\"22\",\"TIMER\":\"OFF\",\"FANSPD\":\"HIGH\",\"CLEAR_FILT\":\"OFF\",\"DIAG_L2_PRD\":\"0\",\"FW_OTA\":\"NONE\",\"IFEEL\":\"OFF\",\"SHABAT\":\"OFF\",\"SLEEP\":\"OFF\"}}"
    },
    "res": 0,
    "res_desc": null
  }
}
```

Response (full)

```json
{
  "id": 99,
  "status": 0,
  "desc": null,
  "data": {
    "timeDelta": 53,
    "commandJson": {
      "OPER": "{\"OPER\":{\"AC_MODE\":\"STBY\",\"AC_STSRC\":\"WI-FI\",\"SPT\":\"22\",\"TIMER\":\"OFF\",\"FANSPD\":\"HIGH\",\"CLEAR_FILT\":\"OFF\",\"DIAG_L2_PRD\":\"0\",\"FW_OTA\":\"NONE\",\"IFEEL\":\"OFF\",\"SHABAT\":\"OFF\",\"SLEEP\":\"OFF\"}}",
      "DIAG_L2": "{\"DIAG_L2\":{\"IDU_RX_CNT\":\"77\",\"IDU_TX_CNT\":\"77\",\"I_CALC_AT\":\"27\",\"I_RAT\":\"27\",\"WI_FI_RSSI\":\"-37\",\"I_ICT\":\"27\",\"I_PUMP\":\"ON\",\"O_ACT_FREQ\":\"0\",\"O_ODU_MODE\":\"IDLE\",\"I_LOGIC_SPT\":\"22\",\"I_RCT\":\"27\",\"GOOD_IR_CNT\":\"3\",\"BAD_IR_CNT\":\"0\",\"DISPLAY_IP\":\"192.168.1.1\",\"IDU_CRC_ERR_RX_CNT\":\"0\",\"IP_HI_PRES\":\"CLOSE\",\"IP_LO_PRES\":\"CLOSE\",\"I_BAD_ICT\":\"NORM\",\"I_BAD_RAT\":\"NORM\",\"I_DEICER\":\"ON\",\"I_FAN_ACT\":\"0\",\"I_LOCK\":\"NO LOCK\",\"I_NLOAD\":\"0\",\"I_ON_OFF_STAT\":\"ON\",\"I_SELFTEST\":\"ON\",\"I_STOP_COMP\":\"NO_RQST\",\"M2L_CRC_ERR_RX_CNT\":\"0\",\"M2L_RX_CNT\":\"0\",\"M2L_TX_CNT\":\"0\",\"MAIN_PWR_STATUS\":\"240\",\"OFAN_TYPE\":\"FANUP\",\"O_AC_CURRENT\":\"0\",\"O_BAD_OMT\":\"NORM\",\"O_CTT\":\"0\",\"O_CUR_RWR_TYPE\":\"AC Current\",\"O_DC_CURRENT\":\"0\",\"O_EEV\":\"0\",\"O_EEV_DMSMP\":\"0\",\"O_FAN\":\"OFF\",\"O_FANDOWN_SPD\":\"0\",\"O_FANUP_SPD\":\"0\",\"O_FORCE_STDBY\":\"ON\",\"O_GLT\":\"0\",\"O_HST\":\"0\",\"O_MODEL\":\"reserved \",\"O_OAT\":\"0\",\"O_OCT\":\"43\",\"O_OMT\":\"0\",\"O_PROT_RESON\":\"0\",\"O_PROT_STAT\":\"0\",\"O_RGT_BAD\":\"NORMAL\",\"O_RLT_BAD\":\"NORMAL\",\"O_RV\":\"COOL\",\"O_SYS_PWR\":\"0\",\"O_TRGT_FREQ\":\"0\",\"SMPS_PWR_STATUS\":\"150\"}}",
      "HB": "{\"HB\":{\"HB_CNT\":\"1130\",\"MESSTYPE\":\"HB\"}}"
    },
    "res": 0,
    "res_desc": null
  }
}
```

# Design

Adapter is a Dockerized program, that takes as input a token and imei, as well as an id of the air conditioner to control.

It has a post helper function, which ensures a valid SID is issued.
It does so by first checking if a sid is available, and if not, issuing one using VALIDATE_TOKEN

If a post fails under certain conditions - it will erase the older SID and retry.
A second failure will cause it to panic.

Upon initializing, it will first fetch a list of devices.

It will then choose the device with the given id. If the ID does not exist, it will panic.

Once the device is chosen, its current telemetry values (OPER and DIAG_L2) will be fetched as a part of the updateState method

This state, along with an associated timestamp will be saved.

two state access functions will be provided

1. getState - returns the current state, regardless of age.
1. getCurrentState - If the current state is stale (by age), updateState will be called first followed by getState

Whenever the state is updated, using setState - the new state will first be sent usind SEND_COMMAND, and then read back using updateState, and asserted to match.

In terms of specific utility functions (turn on/off, set temp, etc) - these will all be conducted on a copy of the state
