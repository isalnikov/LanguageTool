# Скрипт для загрузки полных словарей
# Используйте этот скрипт для загрузки оригинальных словарей

#!/bin/bash

echo "Загрузка словарей для LanguageTool Offline..."

# Создаём дирекории
mkdir -p vocab/en vocab/ru

# Английский словарь (пример - замените URL на актуальный)
echo "Загрузка английского словаря..."
# wget -O vocab/en/words.txt https://example.com/english-words.txt
# Или используйте https://github.com/dwyl/english-words/blob/master/words_alpha.txt

# Русский словарь (пример - замените URL на актуальный)
echo "Загрузка русского словаря..."
# wget -O vocab/ru/words.txt https://example.com/russian-words.txt

echo "Готово!"
echo "Английский словарь: $(wc -l < vocab/en/words.txt) слов"
echo "Русский словарь: $(wc -l < vocab/ru/words.txt) слов"
