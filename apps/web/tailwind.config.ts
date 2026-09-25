import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        felt: {
          950: "#04140c",
          900: "#072013",
          800: "#0a2c1a",
          700: "#0e3a23",
          600: "#12502f",
        },
        gold: {
          300: "#f7e08a",
          400: "#f2cf62",
          500: "#e6b93c",
          600: "#c79a26",
        },
        ivory: "#f5f1e6",
        roulette: {
          red: "#c0392b",
          black: "#161616",
        },
      },
      fontFamily: {
        display: ["Georgia", "Times New Roman", "serif"],
      },
      boxShadow: {
        "gold-glow": "0 0 24px rgba(230, 185, 60, 0.35)",
      },
    },
  },
  plugins: [],
};
export default config;
