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
 *    every bump. An 88KB CLI has no ABI;
 *  - a crash in the recogniser (a codec it dislikes, a model mid-download) takes
 *    down a child process instead of Anna;
 *  - it is independently testable. `Anna.app/Contents/Resources/anna-transcribe
 *    utterance.wav` from a shell answers "is hearing broken, or is Anna broken"
 *    in one command.
 *
 * The cost is one process spawn per utterance, roughly 30ms, paid once after the
 * user has already stopped talking — inside the silence the VAD is waiting
 * through anyway.
 *
 * `requiresOnDeviceRecognition = true` is not a preference here, it is the
 * product. Off-device recognition would ship every utterance to Apple, which is
 * the exact thing docs/PRIVACY.md promises does not happen, and it would fail
 * without a network. If the offline model is missing we fail loudly rather than
 * silently falling back to the network.
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

/*
 * Everything below finishes by calling `exit()` from inside a callback, and the
 * main thread does nothing but run its run loop.
 *
 * The obvious shape — block main on a DispatchSemaphore and signal it from the
 * result handler — was written first and deadlocked every time: Speech delivers
 * its recognition callback on the main queue, and a main thread parked in
 * `semaphore.wait()` never drains it. The symptom is the worst kind, a clean
 * 30-second timeout with no error, which looks exactly like a missing offline
 * model. Authorization happens to survive that treatment because its completion
 * arrives on an arbitrary queue; recognition does not. Do not "simplify" this
 * back into a linear function.
 */

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
let audioUrl = URL(fileURLWithPath: path)

/*
 * Reject a file the recogniser cannot open *before* asking for authorization.
 *
 * SFSpeechRecognizer answers a container it cannot decode with a generic
 * "recognition request failed", indistinguishable from a dozen other faults.
 * Opening it here means a WebM blob that slipped past the converter reports
 * itself as a format problem instead of sending someone hunting through privacy
 * settings.
 */
do {
    _ = try AVAudioFile(forReading: audioUrl)
} catch {
    die(
        .recognitionFailed,
        "Could not read that audio file (\(error.localizedDescription)). It must be a format CoreAudio opens — WAV, CAF, AIFF or m4a — not WebM or Ogg."
    )
}

// -- recognition ------------------------------------------------------------

/// Held at file scope so ARC does not release the task the instant it is made.
var liveTask: SFSpeechRecognitionTask?

func transcribe() {
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
     * dictation, so a fresh Mac reports `false` here until the user has switched
     * on Siri or offline dictation once. Checking up front turns that into one
     * actionable sentence; setting `requiresOnDeviceRecognition` anyway produces
     * an opaque failure several seconds later, after the audio has already been
     * handed over.
     */
    guard recognizer.supportsOnDeviceRecognition else {
        die(
            .modelUnavailable,
            "The offline speech model for \(localeId) is not installed. Open System Settings > Keyboard > Dictation, switch it on and add \(localeId), then try again. Anna will not fall back to Apple's servers."
        )
    }

    let request = SFSpeechURLRecognitionRequest(url: audioUrl)
    request.requiresOnDeviceRecognition = true
    // One finished utterance is already in hand; partials would be discarded.
    request.shouldReportPartialResults = false
    request.taskHint = .dictation
    if #available(macOS 13.0, *) {
        // Punctuation is free here and matters downstream: the clause chunker
        // that drives Anna's speech breathes on sentence boundaries, and a wall
        // of unpunctuated text gives it nothing to breathe on.
        request.addsPunctuation = true
    }

    liveTask = recognizer.recognitionTask(with: request) { result, error in
        if let error {
            let failure = error as NSError
            /*
             * 1110 is kAFAssistantErrorDomain's "no speech detected", and 203 is
             * its sibling for an utterance with nothing in it. The VAD upstream
             * is an energy gate, so it fires on a door or a cough perfectly
             * often; that is an empty transcript, not a fault worth putting in
             * front of anyone.
             */
            if failure.code == 1110 || failure.code == 203 {
                print("")
                exit(0)
            }
            die(.recognitionFailed, "Speech recognition failed: \(error.localizedDescription)")
        }

        guard let result, result.isFinal else { return }
        let best = result.bestTranscription

        /*
         * `confidence` is per-segment and only populated on the final result, so
         * this is a plain mean over the segments that carry a score. Crude — a
         * one-word "yes" counts the same as a long clause — but it is only used
         * to notice a transcript that should not be acted on, and a weighted
         * average would not change that call.
         */
        var confidence: Float = 1
        let scored = best.segments.filter { $0.confidence > 0 }
        if !scored.isEmpty {
            confidence = scored.reduce(0) { $0 + $1.confidence } / Float(scored.count)
        }

        /*
         * The transcript goes to stdout and the confidence to stderr, so a human
         * running this by hand gets exactly the words back and a pipe stays
         * clean. The Node side reads the confidence line; anything it cannot
         * parse is treated as 1, because a missing score must never suppress a
         * good transcript.
         */
        FileHandle.standardError.write(Data("confidence=\(confidence)\n".utf8))
        print(best.formattedString)
        exit(0)
    }
}

// -- authorization ----------------------------------------------------------

func proceed(_ status: SFSpeechRecognizerAuthorizationStatus) {
    switch status {
    case .authorized:
        transcribe()
    case .denied:
        die(.notAuthorized, "Speech recognition permission was denied. Grant it in System Settings > Privacy & Security > Speech Recognition.")
    case .restricted:
        die(.notAuthorized, "Speech recognition is restricted on this Mac (a device policy or parental control blocks it).")
    case .notDetermined:
        die(.notAuthorized, "Speech recognition permission was not granted.")
    @unknown default:
        die(.notAuthorized, "Speech recognition permission is in an unrecognised state.")
    }
}

/*
 * TCC attributes this request to the *responsible* process — the app that
 * spawned us, not this binary — and shows that app's
 * NSSpeechRecognitionUsageDescription. Packaged, that is Anna.app, which
 * declares one in package.json's build.mac.extendInfo. Run straight from a
 * shell the responsible process is the terminal, which declares nothing, and
 * TCC kills the process with SIGABRT before any of this code runs. That is why
 * native/Info.plist is linked into __TEXT,__info_plist as well: it is what
 * makes the helper survive being run on its own for debugging.
 */
if SFSpeechRecognizer.authorizationStatus() == .authorized {
    DispatchQueue.main.async { proceed(.authorized) }
} else {
    SFSpeechRecognizer.requestAuthorization { status in
        DispatchQueue.main.async { proceed(status) }
    }
}

/*
 * A hard ceiling on the whole job, including the consent dialog.
 *
 * The dialog belongs to the responsible app, so launched from a daemon or a
 * headless build it may never be shown to anybody. On-device recognition of a
 * two-second utterance takes a few hundred milliseconds; 40 seconds is far past
 * useful and, unlike waiting forever, still lets Anna say why she did not hear.
 */
Timer.scheduledTimer(withTimeInterval: 40, repeats: false) { _ in
    liveTask?.cancel()
    die(.timedOut, "Speech recognition did not finish in time.")
}

RunLoop.main.run()
