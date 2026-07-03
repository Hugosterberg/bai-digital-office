import { render, screen } from "@testing-library/react";
import "@testing-library/jest-dom";
import App from "./App";

it("renders the bai digital office header", () => {
  render(<App />);
  expect(screen.getByRole("heading", { level: 1 })).toHaveTextContent("bai digital office");
});
