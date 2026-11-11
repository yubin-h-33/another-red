# 웹/앱 플레이어용: 게임 안에서는 키보드 글자를 못 받으므로, 이름 입력은 플레이어(ar.js)에 맡긴다.
# 세이브 폴더에 요청 파일(ar_in_*.req)을 쓰면 플레이어가 입력창을 띄우고 답(ar_in_*.res)을 써 준다.
# 플레이어가 답하지 않으면(예전 플레이어 등) 원래의 화면 글자판(Cursor)으로 넘어간다.
def __ar_ask(helptext, maxlength, initial)
  dir = (System.data_directory rescue nil)
  return nil unless dir && File.directory?(dir)
  base = "#{dir}/ar_in_#{Time.now.to_i}#{rand(1000)}"
  File.open(base + ".req", "wb") { |f| f.write("#{maxlength}\n#{helptext.to_s.gsub(/\s+/, ' ')}\n#{initial}") }
  acked = false
  result = nil
  frames = 0
  loop do
    Graphics.update
    Input.update
    frames += 1
    next unless frames % 10 == 0
    acked ||= File.file?(base + ".ack")
    if File.file?(base + ".res")
      data = File.open(base + ".res", "rb") { |f| f.read }.force_encoding("UTF-8")
      result = data[3..-1] if data.start_with?("OK\n")
      break
    end
    break if !acked && frames > 180   # 3초 안에 받았다는 표시가 없으면 포기
  end
  [".req", ".ack", ".res"].each { |ext| File.delete(base + ext) rescue nil }
  return nil unless result
  text = result.strip.scan(/./m)[0, maxlength].join
  return text.empty? ? nil : text
rescue StandardError
  return nil
end

class Object
  def self.method_added(name)
    return unless name == :pbEnterText && !$__ar_wrapping
    $__ar_wrapping = true
    begin
      Object.send(:alias_method, :__ar_pbEnterText, :pbEnterText)
      Object.send(:define_method, :pbEnterText) do |helptext, minlength, maxlength, initialText = "", *rest|
        text = __ar_ask(helptext, maxlength, initialText)
        next text if text
        ($PokemonSystem.textinput = 0) rescue nil
        __ar_pbEnterText(helptext, minlength, maxlength, initialText, *rest)
      end
      Object.send(:private, :pbEnterText)
    ensure
      $__ar_wrapping = false
    end
  end
end
