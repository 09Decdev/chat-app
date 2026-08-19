# Tính năng chat mới — Tài liệu giới thiệu cho khách hàng

**Ngày cập nhật:** 18/08/2026
**Phạm vi:** Tính năng phòng chat (chat room)

---

## 1. Trả lời tin nhắn (Reply)

Người dùng có thể **trả lời trực tiếp một tin nhắn cụ thể** trong phòng chat:

- Nhấn giữ (long-press) lên một tin nhắn bất kỳ → chọn **"Trả lời"**.
- Tin nhắn trả lời sẽ hiển thị kèm **đoạn trích nội dung tin gốc** (tên người gửi + nội dung), giúp mọi người hiểu rõ câu trả lời đang đề cập đến điều gì.
- Trường hợp tin nhắn được trả lời *đã bị xóa*: nội dung trích dẫn **vẫn được giữ lại** trong tin trả lời, không bị "mất" theo tin gốc.
- Không thể trả lời lại một tin đã bị xóa (nút trả lời tự ẩn / hệ thống chặn), tránh trỏ đến tin không còn tồn tại.

**Lợi ích:** Hội thoại rành mạch, đúng trọng tâm — dễ theo dõi ai đang trả lời cái gì, kể cả trong phòng đông người.

---

## 2. Gắn @ khi nhắn tin (Mention)

Người dùng có thể **gõ `@` để nhắc tên một thành viên** trong phòng:

- Khi gõ `@`, danh sách gợi ý thành viên trong phòng tự động hiển thị → chọn 1 người để chèn `@Tên hiển thị`.
- Người được nhắc tới sẽ thấy **tin nhắn được làm nổi bật** (highlight) để biết mình được gọi đến.
- Danh sách gợi ý luôn khớp với những người **đang trong phòng**, không gợi ý người lạ.

**Lợi ích:** Thu hút đúng sự chú ý của đúng người — trải nghiệm gọi tên tự nhiên như các app chat phổ biến.

---

## 3. Lưu tin nhắn (Bookmark / Tim)

Người dùng có thể **đánh dấu (tim) một tin nhắn** để giữ lại:

- Nhấn giữ (long-press) lên tin nhắn → chọn **"Lưu tin"**.
- Hệ thống lưu lại con trỏ tới tin đó theo tài khoản — tránh lưu trùng.
- Dữ liệu lưu **gắn theo từng tài khoản** — mỗi người chỉ sở hữu danh sách lưu của riêng mình.
- Ghi chú: ở phiên bản hiện tại, hành động "Lưu tin" đã có; màn hình xem lại danh sách tin đã lưu sẽ được bổ sung ở bản sau (API đã sẵn sàng).

**Lợi ích:** Người dùng có chủ động đánh dấu tin quan trọng ngay trong cuộc trò chuyện để không bỏ lỡ thông tin.

---

## 4. Trạng thái "đã xem" (Read receipt)

Người gửi **biết được tin của mình đã được ai đọc hay chưa**:

- Mỗi tin nhắn đã gửi hiển thị trạng thái: **đã gửi** (✓) → **đã xem** (✓✓).
- Trạng thái **"đã xem" hiển thị theo từng người** trong phòng — người gửi nhìn thấy chính xác ai chưa đọc tin của mình.
- Trạng thái cập nhật theo thời gian thực qua luồng socket (server relay) — khi người khác mở máy và xem tới tin nhắn, tick "đã xem" xuất hiện tự động.
- Cơ chế hoạt động tiết kiệm tài nguyên: chỉ ghi nhận "mốc đã đọc" một lần khi người dùng xem tới vị trí mới nhất (có debounce), không phát thông báo liên tục khi lướt.

**Lợi ích:** Tăng độ tin cậy trong giao tiếp — biết khi nào cần nhắn tiếp, khi nào thông tin đã tới được người nhận.

---

## Tóm tắt bảng tính năng

| Tính năng | Cách dùng | Trạng thái |
|-----------|-----------|-----------|
| Trả lời tin nhắn | Long-press tin → "Trả lời" | ✔ Hoàn thành |
| Gắn @ nhắc tên | Gõ `@` → chọn thành viên | ✔ Hoàn thành |
| Lưu tin nhắn | Long-press tin → "Lưu tin" | ✔ Hoàn thành |
| Đã xem (read receipt) | Tự động hiển thị ✓/✓✓ | ✔ Hoàn thành |

## Ghi chú triển khai
- Các tính năng mới **tương thích ngược** với phiên bản app cũ: người dùng chưa cập nhật app vẫn chat bình thường, chỉ không nhìn thấy các tính năng mới.
- Trạng thái "đã xem" hoạt động trong phạm vi **phòng chat đang mở** (phòng chat có thời lượng 3 giờ tự động kết thúc).
- Dữ liệu "tin đã lưu" tuân theo chính sách lưu trữ tin nhắn hiện hành (tin nhắn gốc có hạn định lưu trữ).