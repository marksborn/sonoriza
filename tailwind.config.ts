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
          900: "#27106f",
          600: "#6724d9",
          400: "#922df2",
          dark: "#27106f",
          light: "#922df2",
          soft: "#efe9ff",
        },
        accent: {
          DEFAULT: "#ff7200",
          600: "#ff7200",
          400: "#ff982b",
          light: "#ff982b",
          soft: "#fff1e6",
        },
        canvas: {
          DEFAULT: "#f8f7fb",
          light: "#f8f7fb",
          dark: "#0b021f",
        },
        surface: {
          DEFAULT: "#ffffff",
          light: "#ffffff",
          dark: "#160633",
          subtle: "#1d0b42",
          elevated: "#241052",
        },
        ink: {
          DEFAULT: "#271746",
          light: "#271746",
          inverse: "#fbf9ff",
        },
        muted: {
          DEFAULT: "#71677f",
          light: "#71677f",
          inverse: "#c7b9d9",
        },
        line: {
          DEFAULT: "#e8e3ef",
          light: "#e8e3ef",
          dark: "#49306d",
        },
        success: {
          DEFAULT: "#34d399",
          strong: "#10b981",
          soft: "#073c32",
        },
        warning: {
          DEFAULT: "#fbbf24",
          strong: "#f59e0b",
          soft: "#3d2708",
        },
        danger: {
          DEFAULT: "#fb7185",
          strong: "#f43f5e",
          soft: "#45131f",
        },
        info: {
          DEFAULT: "#38bdf8",
          strong: "#0ea5e9",
          soft: "#082f49",
        },
      },
      opacity: {
        45: "0.45",
        65: "0.65",
        72: "0.72",
      },
      boxShadow: {
        soft: "0 24px 70px -34px rgba(39, 16, 111, 0.38)",
        card: "0 18px 45px -28px rgba(39, 16, 111, 0.28)",
        action: "0 14px 30px -16px rgba(255, 114, 0, 0.58)",
        "product-card": "0 24px 70px -40px rgba(103, 36, 217, 0.62)",
      },
      backgroundImage: {
        "brand-gradient": "linear-gradient(135deg, #27106f 0%, #6724d9 55%, #922df2 100%)",
        "accent-gradient": "linear-gradient(135deg, #ff7200 0%, #ff982b 100%)",
        "product-gradient": "linear-gradient(145deg, #241052 0%, #160633 100%)",
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
