// @vitest-environment node

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const ANDROID_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const REPO_ROOT = resolve(ANDROID_ROOT, "..");

function readRepo(path: string): string {
	return readFileSync(resolve(REPO_ROOT, path), "utf8");
}

describe("Phase 9 CI boundary", () => {
	it("pins the Bun toolchain that owns the committed lockfile format", () => {
		const packageJson = JSON.parse(readRepo("package.json")) as {
			packageManager?: string;
		};
		const androidPackageJson = JSON.parse(readRepo("android/package.json")) as {
			packageManager?: string;
		};
		const lockfile = readRepo("bun.lock");

		expect(packageJson.packageManager).toBe("bun@1.4.2");
		expect(androidPackageJson.packageManager).toBe(packageJson.packageManager);
		expect(lockfile).toMatch(/^\{\n {2}"lockfileVersion": 2,/);
	});

	it("keeps the existing web gates and adds an isolated Android gate", () => {
		const workflow = readRepo(".github/workflows/ci.yml");

		expect(workflow).toContain("check:");
		expect(workflow).toContain("test:");
		expect(workflow).toMatch(/^ {2}android:\s*$/m);
		expect(workflow).toContain("name: Android checks + APK assembly");
		expect(workflow).toContain("bun install --frozen-lockfile");
	});

	it("pins the Android toolchain and runs every scoped JavaScript gate", () => {
		const workflow = readRepo(".github/workflows/ci.yml");

		expect(workflow).toContain("actions/setup-java@c5195efecf7bdfc987ee8bae7a71cb8b11521c00");
		expect(workflow).toContain("java-version: 21");
		expect(workflow).toContain("actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020");
		expect(workflow).toContain("node-version: 24");
		expect(workflow).toContain('"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager"');
		expect(workflow).toContain('sdkmanager" "platforms;android-36" "build-tools;35.0.0"');
		for (const command of ["lint", "typecheck", "test", "build", "cap:sync"]) {
			expect(workflow).toContain(`bun run --cwd android ${command}`);
		}
		expect(workflow).not.toMatch(/run:\s+(?:npx\s+)?cap sync android/);
	});

	it("checks generated Gradle freshness, host tests, and both unsigned APK variants", () => {
		const workflow = readRepo(".github/workflows/ci.yml");

		expect(workflow).toContain("git diff --exit-code --");
		expect(workflow).toContain("android/android/capacitor.settings.gradle");
		expect(workflow).toContain("android/android/app/capacitor.build.gradle");
		expect(workflow).toContain("./gradlew testDebugUnitTest assembleDebug assembleRelease");
		expect(workflow).toContain("actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02");
		expect(workflow).toContain("app-debug.apk");
		expect(workflow).toContain("app-release-unsigned.apk");
		expect(workflow).not.toMatch(/(?:keystore|storePassword|keyPassword|publish|release create)/i);
	});

	it("keeps minimum permissions and repository-wide SAST coverage", () => {
		const ci = readRepo(".github/workflows/ci.yml");
		const semgrep = readRepo(".github/workflows/semgrep.yml");
		const manifest = readRepo("android/android/app/src/main/AndroidManifest.xml");

		expect(ci).toContain("permissions:\n  contents: read");
		expect(ci.match(/persist-credentials: false/g)).toHaveLength(3);
		expect(semgrep).toContain("persist-credentials: false");
		expect(semgrep).toContain("Android");
		expect(semgrep).not.toContain("git fetch");
		expect(semgrep).not.toMatch(/--exclude(?:=|\s+)android(?:\/|\s|$)/);
		expect(manifest).toContain(
			"nosemgrep: java.android.security.exported_activity.exported_activity",
		);
		expect(manifest).toContain("MAIN/LAUNCHER entry point");
	});

	it("documents the reproducible Android build and its honest verification boundary", () => {
		const readme = readRepo("README.md");

		expect(readme).toContain("## Android app");
		expect(readme).toContain("OpenJDK 21");
		expect(readme).toContain("Android SDK 36");
		expect(readme).toContain("bun install --frozen-lockfile");
		for (const command of ["lint", "typecheck", "test", "build", "cap:sync"]) {
			expect(readme).toContain(`bun run --cwd android ${command}`);
		}
		expect(readme).toContain("./gradlew assembleDebug");
		expect(readme).toContain(".rmbak");
		expect(readme).toContain("device credential");
		expect(readme).toContain("169 tests: 65 web + 104 shared-core");
		expect(readme).toContain("No emulator/device result is claimed");
	});

	it("records the Android CI job and completed port as closed", () => {
		const portingPlan = readRepo("android/docs/porting-plan.md");
		const reuseMatrix = readRepo("android/docs/reuse-matrix.md");

		expect(portingPlan).toContain("Android CI job is implemented");
		expect(portingPlan).not.toContain(
			"All five workflows + dependabot config are **web-only today",
		);
		expect(portingPlan).not.toContain("no Android\n  CI work is a remaining product phase");
		expect(reuseMatrix).toContain("Android CI job is implemented");
		const closedStatus = "Phases 0–9 complete; Android port FINAL COMPLETE / CLOSED";
		expect(portingPlan).toContain(closedStatus);
		expect(reuseMatrix).toContain(closedStatus);
		expect(portingPlan).not.toContain("Phase 9 pending");
		expect(reuseMatrix).not.toContain("Phase 9 pending");
	});
});
