<p align="center">
  <img src="https://github.com/homebridge/branding/raw/latest/logos/homebridge-wordmark-logo-vertical.png" width="150">
</p>

<span align="center">

# OpenSpa Homebridge Plugin

</span>

OpenSpa is a Homebridge plugin that allows users to control and monitor their sauna and/or steam room using Apple's HomeKit. This plugin integrates your sauna and steam room controls with HomeKit, providing an easy-to-use interface to manage temperature, humidity, lighting, and fans directly from your iOS devices.

## Purpose

OpenSpa is designed to provide a generic sauna controller that allows users to leverage HomeKit to manage and monitor their sauna and steam room environments. It offers flexibility and customization to fit a variety of hardware setups, enabling users to create a smart sauna experience with ease.

## Hardware

[OpenSpa Controller](https://ungodly.design/products/opensauna)

![OpenSpaController](https://i.imgur.com/GPK4ySn.jpeg)

## Key Features

- **Thermostat Control:** Control a sauna or steam system using HomeKit thermostat controls.
- **Temperature Monitoring:** Use the 4 ADC channels to install NTC thermimstors in the sauna, steam, outside, etc.
- **Humidity Monitoring:** With the optional I2C input, monitor the temperature and humidity of the sauna.
- **Switches:** Control the light and fan using HomeKit switch contorls (on/off).
- **Door Sensors:** Install mangjnetic switches (NC or NO) to monitor the door state of the sauna or steam system to power off while the door is open.
- **Safety Mechanisms:** Configure a variety of temperature thresholds and system timeouts to ensure the system operates safely.

## Configuration

To configure the OpenSpa plugin, you can use the Homebridge UI or edit your `config.json` file directly.

### Developer Setup


Using a terminal, navigate to the project folder and run this command to install the development dependencies:

```
git clone https://github.com/luis-godinez/OpenSpa.git
cd OpenSpa
npm install
```
