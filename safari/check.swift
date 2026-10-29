// Compiles the Safari build's content blocker and regex rules with WebKit,
// the same compiler Safari uses, so that anything it rejects is found on
// the Mac before the extension is installed. Run by safari/package.sh:
//
//   xcrun swift safari/check.swift dist-safari
//
// Checks:
//   1. content-blocker/blockerList.json compiles as a WKContentRuleList.
//      One selector or trigger WebKit rejects fails the whole list, which is
//      why this matters: Safari would then hide nothing.
//   2. Every regexFilter in extension/rulesets/*.json compiles as a content
//      blocker url-filter. Safari compiles declarativeNetRequest rules into
//      content rule lists, so a regex this rejects is one Safari rejects.
//      (urlFilter patterns are not checked: Safari converts them itself.)
// Exit status 0 when both pass, 1 otherwise, with WebKit's own message.
import Foundation
import WebKit

let arguments = CommandLine.arguments
guard arguments.count == 2 else {
    FileHandle.standardError.write("usage: swift safari/check.swift <dist-safari directory>\n".data(using: .utf8)!)
    exit(2)
}
let root = URL(fileURLWithPath: arguments[1])
let storeDirectory = FileManager.default.temporaryDirectory.appendingPathComponent("add-block-check-\(ProcessInfo.processInfo.processIdentifier)")
try FileManager.default.createDirectory(at: storeDirectory, withIntermediateDirectories: true)
defer { try? FileManager.default.removeItem(at: storeDirectory) }
let store = WKContentRuleListStore(url: storeDirectory)!

// Returns nil when the list compiles, otherwise WebKit's error text.
func compile(_ identifier: String, _ json: String) -> String? {
    var result: String?
    var done = false
    store.compileContentRuleList(forIdentifier: identifier, encodedContentRuleList: json) { _, error in
        if let error = error as NSError? {
            // WebKit puts the parse error (which rule, what is wrong) in the
            // user info; the localized description only says it failed.
            let details = error.userInfo.map { "\($0.key): \($0.value)" }.sorted().joined(separator: "; ")
            result = "\(error.localizedDescription) [\(details)]"
        }
        done = true
    }
    while !done {
        RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.02))
    }
    return result
}

func fail(_ message: String) -> Never {
    FileHandle.standardError.write("check.swift: \(message)\n".data(using: .utf8)!)
    exit(1)
}

var failures = 0

// 1. The content blocker.
let blockerURL = root.appendingPathComponent("content-blocker/blockerList.json")
guard let blockerData = try? Data(contentsOf: blockerURL), let blockerJSON = String(data: blockerData, encoding: .utf8) else {
    fail("cannot read \(blockerURL.path)")
}
let blockerRules = (try? JSONSerialization.jsonObject(with: blockerData)) as? [[String: Any]] ?? []
if let error = compile("add-block-content-blocker", blockerJSON) {
    print("FAILED content-blocker/blockerList.json (\(blockerRules.count) rules): \(error)")
    failures += 1
} else {
    print("OK content-blocker/blockerList.json: \(blockerRules.count) rules compiled by WebKit")
}

// 2. The regex rules, as url-filters.
let rulesetsURL = root.appendingPathComponent("extension/rulesets")
let rulesetFiles = ((try? FileManager.default.contentsOfDirectory(atPath: rulesetsURL.path)) ?? []).filter { $0.hasSuffix(".json") }.sorted()
var regexes: [(file: String, id: Int, regex: String)] = []
for file in rulesetFiles {
    let url = rulesetsURL.appendingPathComponent(file)
    guard let data = try? Data(contentsOf: url), let rules = (try? JSONSerialization.jsonObject(with: data)) as? [[String: Any]] else {
        fail("cannot parse \(url.path)")
    }
    for rule in rules {
        if let condition = rule["condition"] as? [String: Any], let regex = condition["regexFilter"] as? String {
            regexes.append((file, rule["id"] as? Int ?? -1, regex))
        }
    }
}
func urlFilterList(_ patterns: [String]) -> String {
    let rules = patterns.map { ["trigger": ["url-filter": $0], "action": ["type": "block"]] }
    return String(data: try! JSONSerialization.data(withJSONObject: rules), encoding: .utf8)!
}
if regexes.isEmpty {
    print("OK no regexFilter rules to check")
} else if compile("add-block-regex", urlFilterList(regexes.map { $0.regex })) == nil {
    print("OK \(regexes.count) regexFilter patterns compiled by WebKit as url-filters")
} else {
    for entry in regexes {
        if let error = compile("add-block-regex-one", urlFilterList([entry.regex])) {
            print("FAILED \(entry.file) rule \(entry.id) regexFilter \(entry.regex): \(error)")
            failures += 1
        }
    }
}

if failures > 0 {
    fail("\(failures) problem(s); see above. Fix the build (scripts/safari.mjs) rather than the output.")
}
print("OK: WebKit accepts the content blocker and every regex rule")
