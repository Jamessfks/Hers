/*
 * Hearing, without a vendor.
 *
 * Anna's owner has one language key and one voice key. Neither vendor does
 * speech-to-text, so before this existed the microphone was decorative: the VAD
 * ran, the bytes crossed IPC, and `transcribeAndRespond` dropped them because no
 * `stt.*` secret was stored. macOS ships a recogniser that needs no key at all.
 *
 * Why a separate executable rather than a Node addon or an FFI binding:
 *
 *  - `SFSpeechRecognizer` is Objective-C/Swift only, and node-gyp in an Electron
 *    app means matching ABI against whatever Electron ships and rebuilding on
 *    every bump. A 40KB CLI has no ABI;
 *  - a crash in the recogniser (a codec it dislikes, a model mid-download) takes
 *    down a child process instead of Anna;
 *  - it is independently testable. `native/transcribe path/to.wav` from a shell
 *    answers "is hearing broken, or is Anna broken" in one command.
 *
 * The cost is one process spawn per utterance, roughly 30ms, paid once after the
 * user has already stopped talking. That is inside the silence the VAD is
 * already waiting through.
 *
 * `requiresOnDeviceRecognition = true` is not a preference here, it is the
 * product. Off-device recognition would ship every utterance to Apple, which is
 * the exact thing docs/PRIVACY.md promises does not happen, and it would fail
 * without a network. If the on-device model is missing we fail loudly rather
 * than silently falling back to the network.
 */

import AVFoundation
import Foundation
import Speech

/*
 * Exit codes are the interface.
 *
 * The Node side needs to tell "you must approve this in System Settings" apart
 * from "that recording had no speech in it" — those want different sentences in
 * front of the user, and parsing English out of stderr to find out is how you
 * get a bug the first time Apple rewords an error. stderr is for the human
 * reading a terminal; the exit code is for the program.
 */
enum Failure: Int32 {
    case usage = 2
    case fileMissing = 3
    case notAuthorized = 4
    case noRecognizer = 5
    case modelUnavailable = 6
    case recognitionFailed = 7
    case timedOut = 8
}

func die(_ code: Failure, _ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(code.rawValue)
}

// -- arguments --------------------------------------------------------------

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    die(.usage, "usage: transcribe <audio-file> [locale]  (e.g. transcribe utterance.wav en-US)")
}

let path = arguments[1]
let localeId = arguments.count >= 3 ? arguments[2] : "en-US"

guard FileManager.default.fileExists(atPath: path) else {
    die(.fileMissing, "No such audio file: \(path)")
}
let url = URL(fileURLWithPath: path)

/*
 * Reject a file the recogniser cannot open *before* asking for authorization.
 *
 * SFSpeechRecognizer answers a container it cannot decode with a generic
 * "recognition request failed", which is indistinguishable from a dozen other
 * faults. Opening it here means a WebM blob that slipped past the converter
 * reports itself as a format problem instead of sending someone hunting through
 * privacy settings.
 */
do {
    _ = try AVAudioFile(forReading: url)
} catch {
    die(.recognitionFailed, "Could not read that audio file (\(error.localizedDescription)). It must be a format CoreAudio opens — WAV, CAF, AIFF or m4a — not WebM or Ogg.")
}

// -- authorization ----------------------------------------------------------

/*
 * A command-line tool has no run loop, so every callback below is bridged
 * through a semaphore. The alternative — spinning `RunLoop.current` — deadlocks
 * whenever the framework decides to deliver on the main queue, which it does.
 */
func requestAuthorization() -> SFSpeechRecognizerAuthorizationStatus {
    var result = SFSpeechRecognizer.authorizationStatus()
    if result == .authorized { return result }

    let gate = DispatchSemaphore(value: 0)
    SFSpeechRecognizer.requestAuthorization { status in
        result = status
        gate.signal()
    }
    // Bounded because the consent dialog belongs to whoever is *responsible* for
    // this process, not to us. Launched from a daemon or a headless build that
    // dialog may never be shown to anybody, and a companion app that hangs
    // forever on a first utterance is worse than one that says why it cannot
    // hear.
    if gate.wait(timeout: .now() + 60) == .timedOut {
        die(.notAuthorized, "Timed out waiting for speech recognition permission.")
    }
    return result
}

switch requestAuthorization() {
case .authorized:
    break
case .denied:
    die(.notAuthorized, "Speech recognition permission was denied. Grant it in System Settings > Privacy & Security > Speech Recognition.")
case .restricted:
    die(.notAuthorized, "Speech recognition is restricted on this Mac (a device policy or parental control blocks it).")
case .notDetermined:
    die(.notAuthorized, "Speech recognition permission was not granted.")
@unknown default:
    die(.notAuthorized, "Speech recognition permission is in an unrecognised state.")
}

// -- recognizer -------------------------------------------------------------

guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeId)) else {
    die(.noRecognizer, "macOS has no speech recogniser for \(localeId).")
}
guard recognizer.isAvailable else {
    die(.noRecognizer, "The \(localeId) speech recogniser is not available right now.")
}

/*
 * On-device support is a *download*, not a capability.
 *
 * macOS fetches the offline model the first time a language is used for
 * dictation, so a fresh Mac reports `false` here until the user has enabled
 * Siri or offline dictation once. Checking up front turns that into one
 * actionable sentence; setting `requiresOnDeviceRecognition` anyway produces an
 * opaque failure several seconds later, after the audio has already been handed
 * over.
 */
guard recognizer.supportsOnDeviceRecognition else {
    die(.modelUnavailable, "The offline speech model for \(localeId) is not installed. Open System Settings > Keyboard > Dictation, switch it on and add \(localeId), then try again. Anna will not fall back to Apple's servers.")
}

let request = SFSpeechURLRecognitionRequest(url: url)
request.requiresOnDeviceRecognition = true
// One finished utterance is already in hand; partials would just be discarded.
request.shouldReportPartialResults = false
request.taskHint = .dictation
if #available(macOS 13.0, *) {
    // Punctuation is free here and matters downstream: the clause chunker that
    // drives Anna's speech breathes on sentence boundaries, and a wall of
    // unpunctuated text gives it nothing to breathe on.
    request.addsPunctuation = true
}

// -- recognition ------------------------------------------------------------

/*
 * `confidence` is per-segment and is *only* populated on the final result, so
 * it is averaged over segments weighted by nothing — a short "yes" and a long
 * clause count the same. That is good enough for the one thing the caller uses
 * it for, which is noticing a transcript it should not act on.
 */
final class Outcome: @unchecked Sendable {
    var text: String?
    var confidence: Float = 1
    var error: Error?
}

let outcome = Outcome()
let done = DispatchSemaphore(value: 0)

let task = recognizer.recognitionTask(with: request) { result, error in
    if let error {
        outcome.error = error
        done.signal()
        return
    }
    guard let result, result.isFinal else { return }

    let best = result.bestTranscription
    outcome.text = best.formattedString
    let scored = best.segments.filter { $0.confidence > 0 }
    if !scored.isEmpty {
        outcome.confidence = scored.reduce(0) { $0 + $1.confidence } / Float(scored.count)
    }
    done.signal()
}

/*
 * A hard ceiling on the whole job.
 *
 * On-device recognition of a two-second utterance takes a few hundred
 * milliseconds, but a model that is mid-download or a corrupt file can leave the
 * task pending with no callback at all. Anna's turn loop is already waiting on
 * this; 30 seconds is far past useful and still finite.
 */
if done.wait(timeout: .now() + 30) == .timedOut {
    task.cancel()
    die(.timedOut, "Speech recognition did not finish in time.")
}

if let error = outcome.error {
    let nsError = error as NSError
    // 1110 is kAFAssistantErrorDomain's "no speech detected". The VAD upstream
    // is an energy gate, so it fires on a door or a cough perfectly often; that
    // is an empty transcript, not a fault worth showing anyone.
    if nsError.code == 1110 {
        print("")
        exit(0)
    }
    die(.recognitionFailed, "Speech recognition failed: \(error.localizedDescription)")
}

guard let text = outcome.text else {
    die(.recognitionFailed, "Speech recognition returned no result.")
}

/*
 * The transcript goes to stdout and the confidence to stderr, so that a human
 * running this by hand gets exactly the words back and a pipe stays clean. The
 * Node side reads the confidence line; anything it cannot parse is treated as
 * 1, because a missing score must never suppress a good transcript.
 */
FileHandle.standardError.write(Data("confidence=\(outcome.confidence)\n".utf8))
print(text)
