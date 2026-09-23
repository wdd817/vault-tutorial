# 可选：把静态包做成一个 nginx 镜像
#   docker build -t vault-tutorial .
#   docker run --rm -p 8080:80 vault-tutorial
FROM nginx:1.27-alpine
COPY . /usr/share/nginx/html
RUN rm -f /usr/share/nginx/html/Dockerfile \
 && sed -i "s|location / {|location / { try_files $uri $uri/ /404.html;|" /etc/nginx/conf.d/default.conf
EXPOSE 80
