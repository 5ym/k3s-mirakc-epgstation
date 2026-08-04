namespace Denpa.Agent;

/// <summary>
/// <c>tuners.yml</c> だけを読む、ごく小さな YAML。
///
/// <para>
/// **既製のものを入れない理由が2つある。** Native AOT では反射で組み立てる
/// 種類のものが素直に動かず、静的な受け皿を別に用意することになる。そして
/// 読む相手は**こちらが形を決めて雛形まで配っているファイル1つ**しかない。
/// </para>
///
/// <para>
/// 受け付けるのはこれだけ。分からないものは**黙って飛ばさず、行番号を付けて
/// 断る** — 設定を半分だけ読んで「チューナーが1本足りない」より、起動時に
/// 何行目が悪いと言うほうがいい。
/// </para>
///
/// <code>
/// tuners:
///     - name: adapter0
///       types: [BS, CS]
///       command: recisdb tune --device ... -
///       disabled: false
/// </code>
/// </summary>
public static class Yaml
{
    /// <summary>1つの `- ` 項目。値は文字列か文字列の並び</summary>
    public sealed class Item
    {
        public Dictionary<string, string> Scalars { get; } = new();
        public Dictionary<string, List<string>> Lists { get; } = new();
    }

    public sealed class YamlException(string message) : Exception(message);

    /// <summary>`key:` の下にぶら下がっている `- ` の並びを読む</summary>
    public static List<Item> ReadSequence(string text, string key)
    {
        var items = new List<Item>();
        var lines = text.Replace("\r\n", "\n").Split('\n');

        var inside = false;
        var indent = -1;
        Item? current = null;

        for (var number = 0; number < lines.Length; number++)
        {
            var raw = StripComment(lines[number]);
            if (raw.Trim().Length == 0) continue;

            var depth = raw.Length - raw.TrimStart(' ').Length;
            var line = raw.Trim();

            if (!inside)
            {
                // 目当ての段落に入るまで、ほかの見出しは読み飛ばす
                if (depth == 0 && line == $"{key}:") inside = true;
                continue;
            }

            // 同じ高さで別の見出しが始まったら、この段落は終わり
            if (depth == 0 && !line.StartsWith('-')) break;

            if (line.StartsWith("- "))
            {
                if (indent < 0) indent = depth;
                current = new Item();
                items.Add(current);
                Assign(current, line[2..].Trim(), number);
                continue;
            }

            if (current is null)
            {
                throw new YamlException($"{number + 1} 行目: `- ` で始まる項目の外に `{line}` があります");
            }
            Assign(current, line, number);
        }

        return items;
    }

    private static void Assign(Item item, string line, int number)
    {
        var colon = line.IndexOf(':');
        if (colon <= 0) throw new YamlException($"{number + 1} 行目: `名前: 値` の形ではありません ({line})");

        var name = line[..colon].Trim();
        var value = line[(colon + 1)..].Trim();

        if (value.StartsWith('[') && value.EndsWith(']'))
        {
            var inner = value[1..^1];
            item.Lists[name] = inner.Trim().Length == 0
                ? []
                : [.. inner.Split(',').Select(part => Unquote(part.Trim()))];
            return;
        }

        item.Scalars[name] = Unquote(value);
    }

    /// <summary>
    /// `#` から後ろを落とす。**引用符の中は残す** — 選局コマンドに `#` が
    /// 入っていることがある
    /// </summary>
    private static string StripComment(string line)
    {
        var quote = '\0';
        for (var i = 0; i < line.Length; i++)
        {
            var c = line[i];
            if (quote != '\0')
            {
                if (c == quote) quote = '\0';
            }
            else if (c is '"' or '\'')
            {
                quote = c;
            }
            else if (c == '#')
            {
                // 行頭か、直前が空白のときだけコメント (`a#b` は値の一部)
                if (i == 0 || line[i - 1] == ' ') return line[..i];
            }
        }
        return line;
    }

    private static string Unquote(string value)
    {
        if (value.Length >= 2 && value[0] == value[^1] && value[0] is '"' or '\'') return value[1..^1];
        return value;
    }
}
