import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./app/**/*.{ts,tsx}", "./components/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        felt: {
          950: "#02131a",
          900: "#052028",
          800: "#072a34",
          700: "#0a3640",
          600: "#0e4a52",
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
