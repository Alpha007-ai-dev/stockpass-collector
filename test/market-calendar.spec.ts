import { describe, it, expect } from "vitest";
import { marketStateAt } from "../src/market-calendar";

const at = (iso: string) => marketStateAt(new Date(iso));

describe("marketStateAt", () => {
	it("keeps the regular weekday rhythm", () => {
		expect(at("2026-10-07T15:00:00Z")).toBe("open"); // Wed 11:00 EDT
		expect(at("2026-10-07T10:00:00Z")).toBe("pre"); // 06:00 EDT
		expect(at("2026-10-07T21:00:00Z")).toBe("after"); // 17:00 EDT
		expect(at("2026-10-07T03:00:00Z")).toBe("closed"); // Tue 23:00 EDT
		expect(at("2026-10-10T15:00:00Z")).toBe("weekend");
	});
	it("treats 2026 full-day holidays as closed", () => {
		for (const d of ["2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07", "2026-11-26", "2026-12-25"]) {
			expect(at(`${d}T15:00:00Z`)).toBe("closed");
		}
	});
	it("applies the weekend observation rules", () => {
		expect(at("2022-12-26T15:00:00Z")).toBe("closed"); // Christmas on Sunday, observed Monday
		expect(at("2021-12-24T15:00:00Z")).toBe("closed"); // Christmas on Saturday, observed Friday
		expect(at("2021-12-31T15:00:00Z")).toBe("open"); // New Year's on Saturday is not observed on Friday
		expect(at("2026-07-04T15:00:00Z")).toBe("weekend");
	});
	it("ends the session at 13:00 ET on early-close days", () => {
		expect(at("2026-11-27T17:30:00Z")).toBe("open"); // 12:30 EST
		expect(at("2026-11-27T18:30:00Z")).toBe("after"); // 13:30 EST
		expect(at("2026-12-24T18:30:00Z")).toBe("after");
		expect(at("2025-07-03T18:30:00Z")).toBe("after"); // 14:30 EDT
		expect(at("2025-07-04T15:00:00Z")).toBe("closed");
	});
	it("does not close ordinary days", () => {
		expect(at("2026-11-25T15:00:00Z")).toBe("open"); // Wed before Thanksgiving
		expect(at("2022-07-03T15:00:00Z")).toBe("weekend"); // Sunday
		expect(at("2022-07-01T18:30:00Z")).toBe("open"); // Fri 14:30 EDT, Jul 4 2022 is a Monday: no early close
	});
});
