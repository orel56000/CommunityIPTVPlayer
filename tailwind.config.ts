import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      fontFamily: {
        sans: [
          '"Plus Jakarta Sans"',
          "Inter",
          "ui-sans-serif",
          "system-ui",
          "-apple-system",
          "Segoe UI",
          "Roboto",
          "Helvetica",
          "Arial",
          "sans-serif",
        ],
      },
      colors: {
        /** Legacy token — prefer `surface` utilities in CSS where possible */
        panel: "rgb(15 23 42 / 0.55)",
        panelAlt: "rgb(2 6 23 / 0.78)",
        surface: {
          DEFAULT: "#030712",
          raised: "rgb(15 23 42 / 0.45)",
          overlay: "rgb(2 6 23 / 0.65)",
        },
      },
      boxShadow: {
        glow: "0 0 0 1px rgba(148, 163, 184, 0.12), 0 12px 40px -8px rgba(0, 0, 0, 0.55)",
        "glow-cyan": "0 0 60px -12px rgba(34, 211, 238, 0.22)",
        "inner-soft": "inset 0 1px 0 0 rgba(255, 255, 255, 0.04)",
      },
      backgroundImage: {
        "gradient-radial": "radial-gradient(var(--tw-gradient-stops))",
      },
    },
  },
  plugins: [],
} satisfies Config;
