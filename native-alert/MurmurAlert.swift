import SwiftUI
import AppKit

// MARK: - Input schema (parsed from stdin JSON)

struct ChipSpec: Decodable {
    let symbol: String   // Either an emoji or an SF Symbol name. Detected at render time.
    let label: String
}

struct ButtonSpec: Decodable {
    let label: String
    let kind: String   // "primary" | "secondary" | "destructive"
    let value: String
}

struct PermissionSpec: Decodable {
    let session: String?
    let tool: String
    let headline: String
    let risk: String
    let riskLabel: String
    let riskIcon: String
    let chips: [ChipSpec]
    let cwd: String?
    let command: String
    let buttons: [ButtonSpec]
    let `default`: String?
}

struct QuestionSpec: Decodable {
    let session: String?
    let header: String?
    let question: String
    let options: [String]
    let allowCustomInput: Bool?
    let customInputPlaceholder: String?
}

/// Top-level discriminated union. JSON includes a `"mode"` field that
/// distinguishes the two alert shapes; missing means "permission" for
/// backwards-compat.
enum Spec {
    case permission(PermissionSpec)
    case question(QuestionSpec)

    static func decode(from data: Data) throws -> Spec {
        struct ModeProbe: Decodable { let mode: String? }
        let probe = try JSONDecoder().decode(ModeProbe.self, from: data)
        let mode = probe.mode ?? "permission"
        switch mode {
        case "question":
            return .question(try JSONDecoder().decode(QuestionSpec.self, from: data))
        default:
            return .permission(try JSONDecoder().decode(PermissionSpec.self, from: data))
        }
    }
}

struct VisualEffect: NSViewRepresentable {
    let material: NSVisualEffectView.Material
    func makeNSView(context: Context) -> NSVisualEffectView {
        let v = NSVisualEffectView()
        v.material = material
        v.blendingMode = .behindWindow
        v.state = .active
        return v
    }
    func updateNSView(_ nsView: NSVisualEffectView, context: Context) {}
}

/// Carries the natural (unclipped) height of the command text up to the card so
/// the code box can size to its content. A greedy ScrollView in a fitting-size
/// window collapses to its minHeight and ignores maxHeight, so we measure the
/// text instead and set an explicit height clamped between a floor and a cap.
struct CodeHeightKey: PreferenceKey {
    static var defaultValue: CGFloat = 0
    static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) {
        value = max(value, nextValue())
    }
}

// MARK: - Design tokens

enum Palette {
    static let chipBg = Color.white.opacity(0.04)
    static let chipRing = Color.white.opacity(0.10)
    static let codeBg = Color.white.opacity(0.05)
    static let codeRing = Color.white.opacity(0.06)
    static let rose = Color(red: 244 / 255, green: 63 / 255, blue: 94 / 255)
    static let amber = Color(red: 245 / 255, green: 158 / 255, blue: 11 / 255)
    static let amberText = Color(red: 252 / 255, green: 211 / 255, blue: 77 / 255)   // amber-300
    static let emeraldText = Color(red: 52 / 255, green: 211 / 255, blue: 153 / 255) // emerald-400
    static let orangeText = Color(red: 251 / 255, green: 146 / 255, blue: 60 / 255)  // orange-400
    static let roseText = Color(red: 251 / 255, green: 113 / 255, blue: 133 / 255)   // rose-400

    /// Outline-pill accent for a given risk level. Matches the dashboard's
    /// Progress widget aesthetic: transparent fill, colored ring, colored text.
    static func riskAccent(_ risk: String) -> Color {
        switch risk {
        case "critical": return roseText
        case "high":     return orangeText
        case "medium":   return amberText
        default:         return emeraldText
        }
    }
}

// MARK: - Shared subviews

struct GlyphIcon: View {
    let symbol: String
    let size: CGFloat
    var color: Color = .primary

    var body: some View {
        if isEmoji(symbol) {
            Text(symbol).font(.system(size: size))
        } else {
            Image(systemName: symbol)
                .font(.system(size: size * 0.9, weight: .semibold))
                .foregroundColor(color)
        }
    }

    private func isEmoji(_ s: String) -> Bool {
        guard let first = s.unicodeScalars.first else { return false }
        return !(first.isASCII)
    }
}

// MARK: - Permission card

final class FocusController: ObservableObject {
    @Published var focusedIndex: Int = 0
}

struct PermissionChip: View {
    let symbol: String
    let label: String

    var body: some View {
        HStack(spacing: 7) {
            GlyphIcon(symbol: symbol, size: 16)
            Text(label)
                .font(.system(size: 15, weight: .medium))
                .foregroundColor(Color.white.opacity(0.85))
        }
        .padding(.horizontal, 13)
        .padding(.vertical, 8)
        .background(
            RoundedRectangle(cornerRadius: 7, style: .continuous)
                .fill(Palette.chipBg)
                .overlay(
                    RoundedRectangle(cornerRadius: 7, style: .continuous)
                        .stroke(Palette.chipRing, lineWidth: 1)
                )
        )
    }
}

struct RiskBadge: View {
    let label: String
    let risk: String

    var body: some View {
        let accent = Palette.riskAccent(risk)
        HStack(spacing: 7) {
            Circle()
                .fill(accent)
                .frame(width: 9, height: 9)
            Text("\(label) risk".uppercased())
                .font(.system(size: 13, weight: .bold))
                .tracking(0.9)
                .foregroundColor(accent)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .background(
            RoundedRectangle(cornerRadius: 999, style: .continuous)
                .stroke(accent.opacity(0.50), lineWidth: 1)
        )
    }
}

struct PermissionCard: View {
    let spec: PermissionSpec
    @ObservedObject var ctrl: FocusController
    let onChoice: (String) -> Void

    // Measured height of the command text; the code box sizes to it, clamped.
    @State private var codeHeight: CGFloat = 0

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 10) {
                        if let s = spec.session, !s.isEmpty {
                            Text(s.uppercased())
                                .font(.system(size: 14, weight: .bold))
                                .tracking(1.1)
                                .foregroundColor(Color.white.opacity(0.55))
                        }
                        HStack(spacing: 7) {
                            Image(systemName: "shield.lefthalf.filled")
                                .font(.system(size: 16, weight: .bold))
                                .foregroundColor(Palette.rose)
                            Text("PERMISSION · \(spec.tool)")
                                .font(.system(size: 14, weight: .bold))
                                .tracking(1.1)
                                .foregroundColor(Palette.rose)
                        }
                    }
                    Text(spec.headline)
                        .font(.system(size: 25, weight: .semibold))
                        .foregroundColor(Color.white.opacity(0.95))
                        .lineLimit(2)
                        .truncationMode(.tail)
                }
                Spacer()
                RiskBadge(label: spec.riskLabel, risk: spec.risk)
            }

            // Chips first — they describe what kind of operation this is,
            // so they belong adjacent to the headline that introduced it.
            if !spec.chips.isEmpty {
                HStack(spacing: 6) {
                    ForEach(0..<spec.chips.count, id: \.self) { i in
                        let c = spec.chips[i]
                        PermissionChip(symbol: c.symbol, label: c.label)
                    }
                }
            }

            ScrollView {
                Text(spec.command)
                    .font(.system(size: 16, design: .monospaced))
                    .foregroundColor(Color.white.opacity(0.85))
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(18)
                    .textSelection(.enabled)
                    .background(
                        GeometryReader { g in
                            Color.clear.preference(key: CodeHeightKey.self, value: g.size.height)
                        }
                    )
            }
            // Size to the command's natural height, clamped to a generous floor
            // (so the box is always comfortably tall) and a hard max-height cap;
            // anything longer than the cap scrolls inside the box.
            .frame(height: min(max(codeHeight, 240), 420))
            .onPreferenceChange(CodeHeightKey.self) { codeHeight = $0 }
            .background(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(Palette.codeBg)
                    .overlay(
                        RoundedRectangle(cornerRadius: 8, style: .continuous)
                            .stroke(Palette.codeRing, lineWidth: 1)
                    )
            )

            if let cwd = spec.cwd {
                HStack(spacing: 7) {
                    Image(systemName: "folder")
                        .font(.system(size: 13, weight: .medium))
                        .foregroundColor(Color.white.opacity(0.50))
                    Text(cwd)
                        .font(.system(size: 14, design: .monospaced))
                        .foregroundColor(Color.white.opacity(0.50))
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }

            HStack(spacing: 12) {
                ForEach(0..<spec.buttons.count, id: \.self) { i in
                    let b = spec.buttons[i]
                    Button(action: { onChoice(b.value) }) {
                        Text(b.label)
                            .frame(minWidth: b.kind == "destructive" ? 88 : 124)
                    }
                    .controlSize(.large)
                    .modifier(PermissionButtonStyling(
                        kind: b.kind,
                        isFocused: ctrl.focusedIndex == i
                    ))
                }
            }
            .padding(.top, 4)

            HStack(spacing: 16) {
                Text("← → navigate")
                    .font(.system(size: 13))
                    .foregroundColor(Color.white.opacity(0.40))
                Text("⏎ select")
                    .font(.system(size: 13))
                    .foregroundColor(Color.white.opacity(0.40))
                if let denyBtn = spec.buttons.first(where: { $0.kind == "destructive" }) {
                    Text("Esc \(denyBtn.label)")
                        .font(.system(size: 13))
                        .foregroundColor(Color.white.opacity(0.40))
                }
            }
        }
        .padding(28)
        .frame(width: 760)
        .background(
            ZStack {
                VisualEffect(material: .hudWindow)
                Color.black.opacity(0.55)
            }
        )
        .overlay(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(Palette.rose.opacity(0.30), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
    }
}

/// Custom button style matching the dashboard's outline-pill aesthetic.
/// Focused button: bright accent text + matching ring + subtle accent-tinted
/// fill. Unfocused: muted white text + subtle gray ring. Destructive variants
/// use rose; everything else uses emerald.
struct OutlinePillButtonStyle: ButtonStyle {
    let accent: Color
    let isFocused: Bool

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.system(size: 15, weight: .semibold))
            .foregroundColor(isFocused ? accent : Color.white.opacity(0.80))
            .padding(.horizontal, 20)
            .padding(.vertical, 11)
            .background(
                RoundedRectangle(cornerRadius: 999, style: .continuous)
                    .fill(
                        configuration.isPressed
                            ? accent.opacity(0.18)
                            : (isFocused ? accent.opacity(0.10) : Color.white.opacity(0.03))
                    )
                    .overlay(
                        RoundedRectangle(cornerRadius: 999, style: .continuous)
                            .stroke(
                                isFocused ? accent.opacity(0.65) : Color.white.opacity(0.15),
                                lineWidth: 1
                            )
                    )
            )
    }
}

struct PermissionButtonStyling: ViewModifier {
    let kind: String
    let isFocused: Bool

    func body(content: Content) -> some View {
        let accent: Color = (kind == "destructive") ? Palette.roseText : Palette.emeraldText
        content.buttonStyle(OutlinePillButtonStyle(accent: accent, isFocused: isFocused))
    }
}

// MARK: - Question card

/// Focused element on the question card. Options are 0..<options.count, then
/// the custom input (if shown), then Send (if input shown), then Cancel.
final class QuestionFocus: ObservableObject {
    @Published var focusedIndex: Int = 0
}

struct OptionButton: View {
    let label: String
    let isFocused: Bool
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            Text(label)
                .font(.system(size: 15, weight: .medium))
                .foregroundColor(Palette.amberText)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 16)
                .padding(.vertical, 10)
                .background(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(isFocused ? Palette.amber.opacity(0.10) : Color.clear)
                        .overlay(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .stroke(
                                    Palette.amber.opacity(isFocused ? 0.70 : 0.40),
                                    lineWidth: 1
                                )
                        )
                )
                // An unfocused row's fill is Color.clear and transparent pixels
                // don't hit-test, so without an explicit content shape only the
                // focused (tinted) row was clickable.
                .contentShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
    }
}

struct QuestionCard: View {
    let spec: QuestionSpec
    @ObservedObject var focus: QuestionFocus
    @Binding var customText: String
    let onSubmit: (String) -> Void
    let onCancel: () -> Void

    private var showInput: Bool { spec.allowCustomInput ?? true }
    private var inputIndex: Int { spec.options.count }
    private var sendIndex: Int { spec.options.count + 1 }
    private var cancelIndex: Int { showInput ? spec.options.count + 2 : spec.options.count }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            // Header: optional session crumb + header tag + question text.
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    if let s = spec.session, !s.isEmpty {
                        Text(s.uppercased())
                            .font(.system(size: 12, weight: .bold))
                            .tracking(1.0)
                            .foregroundColor(Color.white.opacity(0.55))
                    }
                    if let h = spec.header {
                        Text(h.uppercased())
                            .font(.system(size: 12, weight: .bold))
                            .tracking(1.0)
                            .foregroundColor(Palette.amberText)
                            .padding(.horizontal, 9)
                            .padding(.vertical, 4)
                            .background(
                                RoundedRectangle(cornerRadius: 6, style: .continuous)
                                    .fill(Palette.amber.opacity(0.15))
                                    .overlay(
                                        RoundedRectangle(cornerRadius: 6, style: .continuous)
                                            .stroke(Palette.amber.opacity(0.30), lineWidth: 1)
                                    )
                            )
                    }
                }
                Text(spec.question)
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundColor(Color.white.opacity(0.95))
                    .fixedSize(horizontal: false, vertical: true)
            }

            Rectangle()
                .fill(Palette.amber.opacity(0.10))
                .frame(height: 1)

            // Options list — auto-sizes to fit all options so nothing gets clipped.
            if !spec.options.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(0..<spec.options.count, id: \.self) { i in
                        OptionButton(
                            label: spec.options[i],
                            isFocused: focus.focusedIndex == i,
                            onTap: { onSubmit(spec.options[i]) }
                        )
                    }
                }
            }

            // Custom input row.
            if showInput {
                HStack(spacing: 8) {
                    TextField(spec.customInputPlaceholder ?? "Or type a custom answer", text: $customText)
                        .textFieldStyle(.plain)
                        .font(.system(size: 15))
                        .foregroundColor(Color.white.opacity(0.95))
                        .padding(.horizontal, 12)
                        .padding(.vertical, 9)
                        .background(
                            RoundedRectangle(cornerRadius: 6, style: .continuous)
                                .fill(Color.white.opacity(0.04))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                                        .stroke(
                                            focus.focusedIndex == inputIndex
                                                ? Palette.amber.opacity(0.6)
                                                : Color.white.opacity(0.10),
                                            lineWidth: 1
                                        )
                                )
                        )
                        .onSubmit {
                            if !customText.trimmingCharacters(in: .whitespaces).isEmpty {
                                onSubmit(customText.trimmingCharacters(in: .whitespaces))
                            }
                        }

                    Button("Send") {
                        let trimmed = customText.trimmingCharacters(in: .whitespaces)
                        if !trimmed.isEmpty { onSubmit(trimmed) }
                    }
                    .controlSize(.large)
                    .disabled(customText.trimmingCharacters(in: .whitespaces).isEmpty)

                    Button("Cancel") { onCancel() }
                        .controlSize(.large)
                        .buttonStyle(.plain)
                        .foregroundColor(Color.white.opacity(0.55))
                }
            } else {
                HStack {
                    Spacer()
                    Button("Cancel") { onCancel() }
                        .controlSize(.large)
                }
            }

            // Footer hint.
            HStack(spacing: 12) {
                if !spec.options.isEmpty {
                    Text("↑ ↓ navigate")
                        .font(.system(size: 11))
                        .foregroundColor(Color.white.opacity(0.40))
                    Text("⏎ select")
                        .font(.system(size: 11))
                        .foregroundColor(Color.white.opacity(0.40))
                }
                Text("Esc cancel")
                    .font(.system(size: 11))
                    .foregroundColor(Color.white.opacity(0.40))
            }
        }
        .padding(24)
        .frame(width: 680)
        .background(
            ZStack {
                VisualEffect(material: .hudWindow)
                Color.black.opacity(0.55)
            }
        )
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .stroke(Palette.amber.opacity(0.30), lineWidth: 1)
        )
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

// MARK: - Entry point

func readBytes() -> Data {
    FileHandle.standardInput.readDataToEndOfFile()
}

let raw = readBytes()
let spec: Spec
do {
    spec = try Spec.decode(from: raw)
} catch {
    fputs("murmur-alert: invalid spec JSON: \(error)\n", stderr)
    exit(2)
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)

class KeyAlertWindow: NSWindow {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

// Named NSEvent keyCodes referenced by the key monitors below, so the same
// physical keys aren't restated as bare integers in two separate ladders.
enum Key {
    static let left: UInt16 = 123
    static let right: UInt16 = 124
    static let up: UInt16 = 126
    static let down: UInt16 = 125
    static let ret: UInt16 = 36
    static let enter: UInt16 = 76
    static let esc: UInt16 = 53
}

func choose(_ value: String) {
    print("button returned:\(value)")
    fflush(stdout)
    NSApp.stopModal()
}

func cancel() {
    print("button returned:__cancel")
    fflush(stdout)
    NSApp.stopModal()
}

// A holder for the @State customText binding so the NSEvent monitor can read
// it when submitting via Enter.
final class CustomTextHolder: ObservableObject {
    @Published var text: String = ""
}

let hosting: NSHostingView<AnyView>
let monitorHandler: (NSEvent) -> NSEvent?

switch spec {
case .permission(let p):
    let ctrl = FocusController()
    if
        let def = p.default,
        let idx = p.buttons.firstIndex(where: { $0.value == def })
    {
        ctrl.focusedIndex = idx
    }
    hosting = NSHostingView(rootView: AnyView(
        PermissionCard(spec: p, ctrl: ctrl, onChoice: { choose($0) })
    ))
    let count = p.buttons.count
    let destructiveIndex = p.buttons.firstIndex(where: { $0.kind == "destructive" })
    monitorHandler = { event in
        switch event.keyCode {
        case Key.left:
            ctrl.focusedIndex = max(0, ctrl.focusedIndex - 1)
            return nil
        case Key.right:
            ctrl.focusedIndex = min(count - 1, ctrl.focusedIndex + 1)
            return nil
        case Key.ret, Key.enter:
            choose(p.buttons[ctrl.focusedIndex].value)
            return nil
        case Key.esc:
            if let i = destructiveIndex { choose(p.buttons[i].value) }
            return nil
        default:
            return event
        }
    }

case .question(let q):
    let focus = QuestionFocus()
    let holder = CustomTextHolder()
    let textBinding = Binding<String>(
        get: { holder.text },
        set: { holder.text = $0 }
    )
    hosting = NSHostingView(rootView: AnyView(
        QuestionCard(
            spec: q,
            focus: focus,
            customText: textBinding,
            onSubmit: { choose($0) },
            onCancel: { cancel() }
        )
    ))
    let optionCount = q.options.count
    monitorHandler = { event in
        // Esc cancels everywhere.
        if event.keyCode == Key.esc {
            cancel()
            return nil
        }
        // Up/Down only navigate the options list. Tab/Shift-Tab and arrow
        // navigation in/out of the input is handled by SwiftUI itself.
        if event.keyCode == Key.up {
            focus.focusedIndex = max(0, focus.focusedIndex - 1)
            return nil
        }
        if event.keyCode == Key.down {
            focus.focusedIndex = min(max(0, optionCount - 1), focus.focusedIndex + 1)
            return nil
        }
        // Enter: only fire focused option if no input is currently editing.
        // SwiftUI's TextField has its own onSubmit for Enter so when focused
        // there, this monitor won't see the event (text fields swallow it).
        if event.keyCode == Key.ret || event.keyCode == Key.enter {
            if optionCount > 0 && focus.focusedIndex < optionCount {
                choose(q.options[focus.focusedIndex])
                return nil
            }
            // Fall through if no options or focus is on the input/buttons.
        }
        return event
    }
}

let window = KeyAlertWindow(
    contentRect: NSRect(x: 0, y: 0, width: 560, height: 380),
    styleMask: [.borderless],
    backing: .buffered,
    defer: false
)
window.isOpaque = false
window.backgroundColor = .clear
window.hasShadow = true
window.level = .modalPanel
window.isMovableByWindowBackground = true
window.collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary]
window.contentView = hosting

let mouseLoc = NSEvent.mouseLocation
let targetScreen =
    NSScreen.screens.first(where: { NSMouseInRect(mouseLoc, $0.frame, false) })
    ?? NSScreen.main
if let s = targetScreen {
    let sf = s.visibleFrame
    let w = window.frame.size
    window.setFrameOrigin(NSPoint(
        x: sf.midX - w.width / 2,
        y: sf.midY - w.height / 2
    ))
}

NSEvent.addLocalMonitorForEvents(matching: .keyDown, handler: monitorHandler)

window.makeKeyAndOrderFront(nil)
app.activate(ignoringOtherApps: true)
NSApp.runModal(for: window)
window.close()
exit(0)
