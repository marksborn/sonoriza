import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          DEFAULT: "#6724d9",
          dark: "#27106f",
          light: "#922df2",
          soft: "#efe9ff",
        },
        accent: {
          DEFAULT: "#ff7200",
          light: "#ff982b",
          soft: "#fff1e6",
        },
        canvas: "#f8f7fb",
        surface: "#ffffff",
        ink: "#271746",
        muted: "#71677f",
        line: "#e8e3ef",
      },
      opacity: {
        45: "0.45",
        65: "0.65",
        72: "0.72",
      },
      boxShadow: {
        soft: "0 24px 70px -34px rgba(39, 16, 111, 0.38)",
        card: "0 18px 45px -28px rgba(39, 16, 111, 0.28)",
        action: "0 14px 30px -16px rgba(255, 114, 0, 0.72)",
      },
      backgroundImage: {
        "brand-gradient": "linear-gradient(135deg, #27106f 0%, #6724d9 55%, #922df2 100%)",
        "accent-gradient": "linear-gradient(135deg, #ff7200 0%, #ff982b 100%)",
      },
      fontFamily: {
        sans: [
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "BlinkMacSystemFont",
          "Segoe UI",
          "sans-serif",
        ],
      },
    },
  },
  plugins: [],
};

export default config;
