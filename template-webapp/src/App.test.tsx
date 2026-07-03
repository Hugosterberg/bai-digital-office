import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import App from "./App";


it("renders the starter heading", () => {
  render(<App />);
  expect(screen.getByRole("heading")).toBeInTheDocument();
});
