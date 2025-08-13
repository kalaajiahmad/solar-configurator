# solar-configurator
[![Ask DeepWiki](https://devin.ai/assets/askdeepwiki.png)](https://deepwiki.com/kalaajiahmad/solar-configurator)

A professional, offline-first solar system configurator and simulator built with vanilla JavaScript, HTML, and CSS. This tool allows for detailed sizing of off-grid and hybrid solar power systems by modeling load profiles, PV generation, battery storage, and grid assistance.

## Features

*   **Detailed System Modeling:** Configure every aspect of your solar setup, including AC load (day/night), sun hours, system efficiencies (inverter, battery round-trip), battery depth of discharge (DoD), and desired autonomy.
*   **Dynamic Simulation:** Runs a time-step simulation (15-minute intervals) to model the battery's state of charge (SOC) over several days. The simulation accurately reflects a half-sine wave PV generation profile, electrical loads, and C-rate limits for battery charging/discharging.
*   **Grid Assistance:** Model a hybrid system with grid power available during specific hours to supplement the load and charge the batteries.
*   **Interactive Charts:** Instantly visualize the system's performance with two key charts:
    *   **Daily Energy Balance:** A bar chart comparing daily/nightly load vs. PV generation and grid energy.
    *   **Battery State of Charge (SOC):** A line chart showing the battery SOC percentage over the configured simulation period.
*   **Shareable Configurations:** Generate a unique URL that saves all your current input parameters. Share this link with others to let them view and tweak your configuration.
*   **Exportable Reports:** Create a self-contained HTML report with a single click. The report includes all input configurations, key output figures, and chart images, perfect for printing or sharing as a PDF.
*   **Responsive & Offline-Ready:** The tool is a single-page application with no external dependencies, ensuring it loads instantly and works perfectly offline. The responsive design provides a seamless experience on desktop, tablet, and mobile devices.

## How It Works

The application combines two main calculation methods to provide a comprehensive analysis:

1.  **Average Sizing:** It first calculates the high-level requirements for the PV array and battery bank based on average daily loads, peak sun hours, and desired nights of autonomy. This provides a quick estimate for an initial system design.
2.  **Time-Step Simulation:** It then runs a more granular simulation to validate the configured system. Over a user-defined number of days, it models:
    *   **PV Generation:** DC power from the PV array is modeled using a half-sine wave profile during daylight hours.
    *   **Load Demand:** AC load is converted to its DC equivalent (accounting for inverter efficiency) and drawn from the system.
    *   **Battery Dynamics:** The battery is charged by surplus PV/grid power and discharged to cover deficits. Calculations respect round-trip efficiency, Depth of Discharge (DoD), and C-rate limits for charge/discharge, flagging any violations.
    *   **Grid Interaction:** If enabled, the grid covers load deficits and/or charges the battery during its availability window, up to a specified power limit.

All calculations and chart renderings happen in real-time in the browser as you adjust the input parameters.

## Usage

1.  Clone the repository and open `index.html` in a web browser, or access it via a deployed link.
2.  Adjust the parameters in the **Inputs** panel on the left. The UI is divided into logical sections:
    *   Load & Sun
    *   Efficiencies & Autonomy
    *   Battery Configuration
    *   Electrical Limits
    *   Grid Assist
3.  Observe the **Key Outputs** and interactive charts update instantly with each change. The outputs show required PV/battery sizes and the performance of your *configured* system.
4.  Use the buttons to:
    *   **Load Ahmad’s System:** Load a default, pre-configured system profile.
    *   **Reset:** Return all parameters to their initial default values.
    *   **Copy share link:** Generate a URL with your current configuration encoded in it.
    *   **Export report:** Download a comprehensive HTML report of your current setup.
