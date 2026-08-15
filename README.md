# NguonC Stremio Addon v3

V3 giữ catalog phân trang của V2 và thêm một bước an toàn cho playback:

- Lấy `embed` từ NguonC.
- Fetch HTML công khai của embed.
- Tìm URL media `.m3u8` hoặc `.mp4` đã được công khai trong HTML.
- Nếu tìm thấy, trả URL đó cho Stremio.
- Nếu không tìm thấy, trả `externalUrl` để mở player trong trình duyệt.

V3 **không**:
- bẻ token,
- giải mã obfuscation,
- vượt CAPTCHA/DRM,
- bypass access control,
- hoặc proxy toàn bộ video.

## Chạy

```bash
npm install
npm start
```

Manifest:

`http://127.0.0.1:7000/manifest.json`

Nếu server V2 đang chạy, trước tiên Ctrl+C và trả lời `Y` khi Windows hỏi `Terminate batch job (Y/N)?`.

## Lưu ý

Môi trường kiểm tra bên ngoài có thể nhận 403 từ một số hostname `embed*.streamc.xyz`, trong khi Chrome của người dùng có thể mở được. Vì vậy V3 được thiết kế để thử fetch từ chính máy đang chạy addon; kết quả phụ thuộc vào server embed tại thời điểm chạy.

Nếu HTML embed chỉ tạo URL media bằng JavaScript sau khi tải, V3 sẽ fallback sang external player thay vì cố vượt cơ chế đó.
